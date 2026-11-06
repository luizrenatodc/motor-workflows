import assert from "node:assert/strict";
import { test } from "node:test";
import type { Passo } from "../src/grafo.ts";
import { Motor, type Acao } from "../src/motor.ts";
import { ACOES, FLUXOS } from "../src/demo.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const motor = (acoes: Record<string, Acao>, passos: Passo[], concorrencia = 4, caminho?: string) => {
  const m = new Motor({ acoes, concorrencia, caminho, dormir: async () => {} });
  m.salvarFluxo({ id: "f", nome: "f", passos });
  return m;
};
const estados = (m: Motor, id: string) => Object.fromEntries((m.detalhe(id)!.passos as { passo_id: string; status: string }[]).map((p) => [p.passo_id, p.status]));
const ok: Acao = () => "ok";

test("repassa saídas pelo contexto", async () => {
  const m = motor({ a: () => ({ n: 2 }), b: ({ n }) => n * 10 }, [{ id: "a", acao: "a" }, { id: "b", acao: "b", depende: ["a"], params: { n: "{{ passos.a.saida.n }}" } }]);
  const id = await m.iniciar("f");
  const b = (m.detalhe(id)!.passos as { passo_id: string; saida: string }[]).find((p) => p.passo_id === "b");
  assert.equal(b?.saida, "20");
});

test("roda ramos paralelos respeitando o limite de concorrência", async () => {
  let agora = 0, pico = 0;
  const lenta: Acao = async () => { pico = Math.max(pico, ++agora); await new Promise((r) => setTimeout(r, 5)); agora--; };
  const passos = ["a", "b", "c", "d", "e"].map((id) => ({ id, acao: "x" }));
  await motor({ x: lenta }, passos, 2).iniciar("f");
  assert.equal(pico, 2);
});

test("tenta de novo com espera exponencial e recupera", async () => {
  const esperas: number[] = [];
  const m = new Motor({ dormir: async (ms) => esperas.push(ms), acoes: { x: (_, { tentativa }) => { if (tentativa < 3) throw new Error("falhou"); return 1; } } });
  m.salvarFluxo({ id: "f", nome: "f", passos: [{ id: "a", acao: "x", tentativas: 3, esperaMs: 100 }] });
  assert.equal(estados(m, await m.iniciar("f")).a, "sucesso");
  assert.deepEqual(esperas, [100, 200]);
});

test("falha propaga: dependentes são pulados e a execução falha", async () => {
  const m = motor({ x: () => { throw new Error("quebrou"); }, y: ok }, [{ id: "a", acao: "x" }, { id: "b", acao: "y", depende: ["a"] }, { id: "c", acao: "y" }]);
  const id = await m.iniciar("f");
  assert.deepEqual(estados(m, id), { a: "falhou", b: "pulado", c: "sucesso" });
  assert.equal((m.detalhe(id)!.execucao as unknown as { status: string }).status, "falhou");
});

test("condição escolhe o ramo e a junção continua", async () => {
  const m = motor({ s: () => ({ v: 1 }), y: ok }, [
    { id: "s", acao: "s" },
    { id: "sim", acao: "y", depende: ["s"], se: "passos.s.saida.v == 1" },
    { id: "nao", acao: "y", depende: ["s"], se: "passos.s.saida.v == 2" },
    { id: "fim", acao: "y", depende: ["sim", "nao"], juncao: true },
  ]);
  assert.deepEqual(estados(m, await m.iniciar("f")), { s: "sucesso", sim: "sucesso", nao: "pulado", fim: "sucesso" });
});

test("sem junção, ramo pulado pula o seguinte", async () => {
  const m = motor({ y: ok }, [{ id: "a", acao: "y", se: "false" }, { id: "b", acao: "y", depende: ["a"] }]);
  assert.deepEqual(estados(m, await m.iniciar("f")), { a: "pulado", b: "pulado" });
});

test("tempo limite interrompe a espera por uma ação presa", async () => {
  const m = motor({ x: () => new Promise(() => {}) }, [{ id: "a", acao: "x", limiteMs: 10 }]);
  const id = await m.iniciar("f");
  assert.equal(estados(m, id).a, "falhou");
  assert.match((m.detalhe(id)!.passos as { erro: string }[])[0].erro, /Tempo limite/);
});

test("retoma depois de queda sem repetir passos concluídos", async () => {
  const caminho = join(mkdtempSync(join(tmpdir(), "motor-")), "m.db");
  let contagem = 0;
  const conta: Acao = () => ++contagem;
  const passos: Passo[] = [{ id: "a", acao: "conta" }, { id: "b", acao: "segunda", depende: ["a"] }];
  const antes = motor({ conta, segunda: () => new Promise(() => {}) }, passos, 4, caminho);
  void antes.iniciar("f");
  await new Promise((r) => setTimeout(r, 30));
  const depois = motor({ conta, segunda: ok }, passos, 4, caminho);
  const [id] = await depois.retomarInterrompidas();
  assert.deepEqual(estados(depois, id), { a: "sucesso", b: "sucesso" });
  assert.equal(contagem, 1);
});

test("recusa fluxo com ação desconhecida", () => {
  assert.throws(() => motor({}, [{ id: "a", acao: "nada" }]), /Ação desconhecida/);
});

test("agenda dispara uma vez e recalcula, mesmo com atraso", async () => {
  const m = motor({ y: ok }, [{ id: "a", acao: "y" }]);
  m.agendar("f", "0 3 * * *", {}, new Date("2030-01-01T00:00:00Z"));
  assert.equal((await m.verificarAgendas(new Date("2030-01-01T02:59:00Z"))).length, 0);
  assert.equal((await m.verificarAgendas(new Date("2030-01-05T12:00:00Z"))).length, 1);
  assert.equal((await m.verificarAgendas(new Date("2030-01-05T12:01:00Z"))).length, 0);
});

test("fluxo de demonstração segue o ramo certo pelo score", async () => {
  const m = new Motor({ acoes: ACOES, dormir: async () => {} });
  for (const f of FLUXOS) m.salvarFluxo(f);
  const baixo = estados(m, await m.iniciar("onboarding", { cliente: "A", documento: "000420" }));
  assert.equal(baixo.revisao, "sucesso");
  assert.equal(baixo.criar_conta, "pulado");
  assert.equal(baixo.avisar, "sucesso");
});
