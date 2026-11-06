import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { ACOES, ENTRADAS, FLUXOS } from "./demo.ts";
import { camadas } from "./grafo.ts";
import { Motor } from "./motor.ts";

const PUBLICO = join(import.meta.dirname, "..", "public");
const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

const motor = new Motor({ caminho: process.env.BANCO ?? "motor.db", acoes: ACOES });
for (const f of FLUXOS) motor.salvarFluxo(f);
await motor.retomarInterrompidas();
if (!motor.execucoes(1).length) {
  for (const [fluxo, entrada] of ENTRADAS) await motor.iniciar(fluxo, entrada);
  motor.agendar("etl-noturno", "0 3 * * *");
  motor.agendar("onboarding", "*/15 8-18 * * 1-5", { cliente: "Lote", documento: "1234567700" });
}
setInterval(() => motor.verificarAgendas().catch(console.error), 30_000).unref();

const json = (res: ServerResponse, status: number, corpo: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(corpo));
async function ler(req: IncomingMessage) {
  let t = "";
  for await (const p of req) t += p;
  return t ? JSON.parse(t) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const rota = `${req.method} ${url.pathname}`;
  try {
    if (rota === "GET /api/painel") return json(res, 200, { execucoes: motor.execucoes(), metricas: motor.metricas(), agendas: motor.agendas() });
    if (rota === "GET /api/fluxos") return json(res, 200, motor.fluxos().map((f) => ({ ...f, camadas: camadas(f.passos) })));
    if (rota === "POST /api/execucoes") {
      const { fluxo, entrada } = await ler(req);
      return json(res, 201, { id: await motor.iniciar(fluxo, entrada) });
    }
    const d = url.pathname.match(/^\/api\/execucoes\/([\w-]+)$/);
    if (d && req.method === "GET") {
      const detalhe = motor.detalhe(d[1]);
      if (!detalhe) return json(res, 404, { erro: "Não encontrada" });
      return json(res, 200, { ...detalhe, camadas: camadas(detalhe.fluxo.passos) });
    }
    if (req.method !== "GET") return json(res, 404, { erro: "Rota inexistente" });
    const arquivo = normalize(url.pathname === "/" ? "index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const conteudo = await readFile(join(PUBLICO, arquivo));
    res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] ?? "text/plain" }).end(conteudo);
  } catch (erro) {
    const e = erro as NodeJS.ErrnoException;
    json(res, e.code === "ENOENT" ? 404 : 400, { erro: e.message });
  }
}).listen(Number(process.env.PORTA ?? 3000), () => console.log("Painel no ar"));
