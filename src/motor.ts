import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pausar } from "node:timers/promises";
import { proximaExecucao } from "./cron.ts";
import { avaliar, interpolar } from "./expressao.ts";
import { camadas, type Fluxo, type Passo } from "./grafo.ts";

export type Contexto = { entrada: unknown; passos: Record<string, { saida: unknown }> };
export type Acao = (params: any, contexto: Contexto & { tentativa: number }) => Promise<unknown> | unknown;
type EstadoPasso = "pendente" | "rodando" | "sucesso" | "falhou" | "pulado";
type LinhaPasso = { passo_id: string; status: EstadoPasso; tentativas: number; saida: string | null; erro: string | null; inicio: number | null; fim: number | null };

type Opcoes = { caminho?: string; acoes: Record<string, Acao>; concorrencia?: number; dormir?: (ms: number) => Promise<unknown> };

export class Motor {
  #db: DatabaseSync;
  #acoes: Record<string, Acao>;
  #concorrencia: number;
  #dormir: (ms: number) => Promise<unknown>;

  constructor(o: Opcoes) {
    this.#db = new DatabaseSync(o.caminho ?? ":memory:");
    this.#acoes = o.acoes;
    this.#concorrencia = o.concorrencia ?? 4;
    this.#dormir = o.dormir ?? ((ms) => pausar(ms));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS fluxos (id TEXT PRIMARY KEY, definicao TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execucoes (
        id TEXT PRIMARY KEY, fluxo_id TEXT NOT NULL REFERENCES fluxos(id), status TEXT NOT NULL,
        entrada TEXT NOT NULL, inicio INTEGER NOT NULL, fim INTEGER
      );
      CREATE TABLE IF NOT EXISTS passos (
        execucao_id TEXT NOT NULL REFERENCES execucoes(id), passo_id TEXT NOT NULL, status TEXT NOT NULL,
        tentativas INTEGER NOT NULL DEFAULT 0, saida TEXT, erro TEXT, inicio INTEGER, fim INTEGER,
        PRIMARY KEY (execucao_id, passo_id)
      );
      CREATE TABLE IF NOT EXISTS agendas (fluxo_id TEXT PRIMARY KEY REFERENCES fluxos(id), cron TEXT NOT NULL, entrada TEXT NOT NULL, proxima INTEGER NOT NULL);
    `);
  }

  salvarFluxo(fluxo: Fluxo): void {
    camadas(fluxo.passos);
    for (const p of fluxo.passos) if (!this.#acoes[p.acao]) throw new Error(`Ação desconhecida: ${p.acao}`);
    this.#db.prepare("INSERT INTO fluxos (id, definicao) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET definicao = excluded.definicao").run(fluxo.id, JSON.stringify(fluxo));
  }

  fluxo(id: string): Fluxo {
    const l = this.#db.prepare("SELECT definicao FROM fluxos WHERE id = ?").get(id) as { definicao: string } | undefined;
    if (!l) throw new Error(`Fluxo não encontrado: ${id}`);
    return JSON.parse(l.definicao);
  }

  fluxos(): Fluxo[] {
    return (this.#db.prepare("SELECT definicao FROM fluxos ORDER BY id").all() as { definicao: string }[]).map((l) => JSON.parse(l.definicao));
  }

  async iniciar(fluxoId: string, entrada: unknown = {}): Promise<string> {
    const fluxo = this.fluxo(fluxoId);
    const id = randomUUID();
    this.#db.prepare("INSERT INTO execucoes (id, fluxo_id, status, entrada, inicio) VALUES (?, ?, 'rodando', ?, ?)").run(id, fluxoId, JSON.stringify(entrada), Date.now());
    for (const p of fluxo.passos) this.#db.prepare("INSERT INTO passos (execucao_id, passo_id, status) VALUES (?, ?, 'pendente')").run(id, p.id);
    await this.#rodar(id);
    return id;
  }

  /** Continua execuções interrompidas. Passos concluídos não repetem; o passo em andamento volta para a fila. */
  async retomarInterrompidas(): Promise<string[]> {
    const ids = (this.#db.prepare("SELECT id FROM execucoes WHERE status = 'rodando'").all() as { id: string }[]).map((l) => l.id);
    for (const id of ids) {
      this.#db.prepare("UPDATE passos SET status = 'pendente' WHERE execucao_id = ? AND status = 'rodando'").run(id);
      await this.#rodar(id);
    }
    return ids;
  }

  async #rodar(id: string): Promise<void> {
    const execucao = this.#db.prepare("SELECT fluxo_id, entrada FROM execucoes WHERE id = ?").get(id) as { fluxo_id: string; entrada: string };
    const { passos } = this.fluxo(execucao.fluxo_id);
    const estado = new Map((this.#db.prepare("SELECT * FROM passos WHERE execucao_id = ?").all(id) as LinhaPasso[]).map((l) => [l.passo_id, l]));
    const contexto: Contexto = { entrada: JSON.parse(execucao.entrada), passos: {} };
    for (const l of estado.values()) if (l.status === "sucesso") contexto.passos[l.passo_id] = { saida: JSON.parse(l.saida ?? "null") };

    const emAndamento = new Map<string, Promise<void>>();
    const terminou = (s: EstadoPasso) => s === "sucesso" || s === "falhou" || s === "pulado";

    while (true) {
      let mudou = true;
      while (mudou) {
        mudou = false;
        for (const p of passos) {
          const linha = estado.get(p.id)!;
          if (linha.status !== "pendente" || emAndamento.has(p.id)) continue;
          const deps = (p.depende ?? []).map((d) => estado.get(d)!.status);
          if (!deps.every(terminou)) continue;
          const seguir = p.juncao ? deps.includes("sucesso") : deps.every((s) => s === "sucesso");
          if (!seguir) {
            this.#atualizar(id, linha, { status: "pulado", erro: deps.includes("falhou") ? "Dependência falhou" : null });
            mudou = true;
            continue;
          }
          if (p.se && !avaliar(p.se, contexto)) {
            this.#atualizar(id, linha, { status: "pulado" });
            mudou = true;
            continue;
          }
          if (emAndamento.size >= this.#concorrencia) continue;
          const tarefa = this.#executar(id, p, linha, contexto).finally(() => emAndamento.delete(p.id));
          emAndamento.set(p.id, tarefa);
        }
      }
      if (!emAndamento.size) break;
      await Promise.race(emAndamento.values());
    }

    const falhou = [...estado.values()].some((l) => l.status === "falhou");
    this.#db.prepare("UPDATE execucoes SET status = ?, fim = ? WHERE id = ?").run(falhou ? "falhou" : "sucesso", Date.now(), id);
  }

  async #executar(id: string, passo: Passo, linha: LinhaPasso, contexto: Contexto): Promise<void> {
    const maximo = passo.tentativas ?? 1;
    this.#atualizar(id, linha, { status: "rodando", inicio: Date.now(), tentativas: 0 });
    for (let tentativa = 1; tentativa <= maximo; tentativa++) {
      this.#atualizar(id, linha, { tentativas: tentativa });
      try {
        const params = interpolar(passo.params ?? {}, contexto);
        const saida = await this.#comLimite(Promise.resolve().then(() => this.#acoes[passo.acao](params, { ...contexto, tentativa })), passo.limiteMs);
        contexto.passos[passo.id] = { saida };
        this.#atualizar(id, linha, { status: "sucesso", saida: JSON.stringify(saida ?? null), erro: null, fim: Date.now() });
        return;
      } catch (erro) {
        this.#atualizar(id, linha, { erro: (erro as Error).message });
        if (tentativa < maximo) await this.#dormir((passo.esperaMs ?? 100) * 2 ** (tentativa - 1));
      }
    }
    this.#atualizar(id, linha, { status: "falhou", fim: Date.now() });
  }

  async #comLimite<T>(tarefa: Promise<T>, limiteMs?: number): Promise<T> {
    if (!limiteMs) return tarefa;
    let relogio: NodeJS.Timeout;
    const estouro = new Promise<never>((_, recusar) => { relogio = setTimeout(() => recusar(new Error(`Tempo limite de ${limiteMs} ms`)), limiteMs); });
    return Promise.race([tarefa, estouro]).finally(() => clearTimeout(relogio));
  }

  #atualizar(id: string, linha: LinhaPasso, mudancas: Partial<LinhaPasso>): void {
    Object.assign(linha, mudancas);
    this.#db.prepare("UPDATE passos SET status = ?, tentativas = ?, saida = ?, erro = ?, inicio = ?, fim = ? WHERE execucao_id = ? AND passo_id = ?")
      .run(linha.status, linha.tentativas, linha.saida, linha.erro, linha.inicio, linha.fim, id, linha.passo_id);
  }

  agendar(fluxoId: string, cron: string, entrada: unknown = {}, agora = new Date()): void {
    this.fluxo(fluxoId);
    this.#db.prepare("INSERT INTO agendas (fluxo_id, cron, entrada, proxima) VALUES (?, ?, ?, ?) ON CONFLICT(fluxo_id) DO UPDATE SET cron = excluded.cron, entrada = excluded.entrada, proxima = excluded.proxima")
      .run(fluxoId, cron, JSON.stringify(entrada), proximaExecucao(cron, agora).getTime());
  }

  /** Dispara o que venceu. Se o processo ficou parado, roda uma vez só e recalcula a partir de agora. */
  async verificarAgendas(agora = new Date()): Promise<string[]> {
    const vencidas = this.#db.prepare("SELECT * FROM agendas WHERE proxima <= ?").all(agora.getTime()) as { fluxo_id: string; cron: string; entrada: string }[];
    const ids: string[] = [];
    for (const a of vencidas) {
      this.#db.prepare("UPDATE agendas SET proxima = ? WHERE fluxo_id = ?").run(proximaExecucao(a.cron, agora).getTime(), a.fluxo_id);
      ids.push(await this.iniciar(a.fluxo_id, JSON.parse(a.entrada)));
    }
    return ids;
  }

  agendas() {
    return this.#db.prepare("SELECT fluxo_id, cron, proxima FROM agendas ORDER BY proxima").all();
  }

  execucoes(limite = 30) {
    return this.#db.prepare("SELECT id, fluxo_id, status, entrada, inicio, fim FROM execucoes ORDER BY rowid DESC LIMIT ?").all(limite);
  }

  detalhe(id: string) {
    const execucao = this.#db.prepare("SELECT * FROM execucoes WHERE id = ?").get(id) as { fluxo_id: string } | undefined;
    if (!execucao) return undefined;
    return { execucao, passos: this.#db.prepare("SELECT * FROM passos WHERE execucao_id = ?").all(id), fluxo: this.fluxo(execucao.fluxo_id) };
  }

  metricas() {
    return {
      porStatus: this.#db.prepare("SELECT status, COUNT(*) AS total FROM execucoes GROUP BY status").all(),
      retentativas: (this.#db.prepare("SELECT COALESCE(SUM(tentativas - 1), 0) AS total FROM passos WHERE tentativas > 1").get() as { total: number }).total,
      duracaoMedia: (this.#db.prepare("SELECT COALESCE(AVG(fim - inicio), 0) AS media FROM execucoes WHERE fim IS NOT NULL").get() as { media: number }).media,
    };
  }
}
