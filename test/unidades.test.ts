import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretarCron, proximaExecucao } from "../src/cron.ts";
import { avaliar, interpolar } from "../src/expressao.ts";
import { camadas } from "../src/grafo.ts";

test("ordena em camadas", () => {
  const r = camadas([{ id: "c", acao: "x", depende: ["a", "b"] }, { id: "a", acao: "x" }, { id: "b", acao: "x", depende: ["a"] }]);
  assert.deepEqual(r, [["a"], ["b"], ["c"]]);
});

test("recusa ciclos, duplicados e dependências soltas", () => {
  assert.throws(() => camadas([{ id: "a", acao: "x", depende: ["b"] }, { id: "b", acao: "x", depende: ["a"] }]), /Ciclo/);
  assert.throws(() => camadas([{ id: "a", acao: "x" }, { id: "a", acao: "x" }]), /mesmo id/);
  assert.throws(() => camadas([{ id: "a", acao: "x", depende: ["z"] }]), /não existe/);
});

test("avalia precedência, lógica e caminhos", () => {
  const c = { a: { b: 5 }, nome: "x" };
  assert.equal(avaliar("1 + 2 * 3", c), 7);
  assert.equal(avaliar("(1 + 2) * 3", c), 9);
  assert.equal(avaliar("a.b >= 5 && nome == 'x'", c), true);
  assert.equal(avaliar("!(a.b > 9) || false", c), true);
  assert.equal(avaliar("a.c.d", c), undefined);
});

test("não alcança protótipos nem executa código", () => {
  assert.equal(avaliar("constructor.name", {}), undefined);
  assert.equal(avaliar("a.__proto__", { a: {} }), undefined);
  assert.throws(() => avaliar("process.exit(1)", {}));
  assert.throws(() => avaliar("1 +", {}));
  assert.throws(() => avaliar("1 2", {}));
});

test("interpola preservando o tipo quando é só a expressão", () => {
  assert.equal(interpolar("{{ n }}", { n: 5 }), 5);
  assert.equal(interpolar("total: {{ n * 2 }}", { n: 5 }), "total: 10");
  assert.deepEqual(interpolar({ a: ["{{ n }}"] }, { n: 1 }), { a: [1] });
});

const proxima = (cron: string, apos: string) => proximaExecucao(cron, new Date(apos)).toISOString();

test("calcula o próximo disparo", () => {
  assert.equal(proxima("0 3 * * *", "2030-01-01T03:00:00Z"), "2030-01-02T03:00:00.000Z");
  assert.equal(proxima("*/15 * * * *", "2030-01-01T10:16:00Z"), "2030-01-01T10:30:00.000Z");
  assert.equal(proxima("0 9 * * 1", "2030-01-02T00:00:00Z"), "2030-01-07T09:00:00.000Z");
  assert.equal(proxima("30 8-18/2 * * *", "2030-01-01T09:00:00Z"), "2030-01-01T10:30:00.000Z");
  assert.equal(proxima("0 0 29 2 *", "2030-01-01T00:00:00Z"), "2032-02-29T00:00:00.000Z");
});

test("dia e dia da semana definidos combinam com OU", () => {
  assert.equal(proxima("0 0 15 * 1", "2030-01-08T00:00:00Z"), "2030-01-14T00:00:00.000Z");
});

test("recusa expressões inválidas", () => {
  assert.throws(() => interpretarCron("* * *"), /5 campos/);
  assert.throws(() => interpretarCron("60 * * * *"), /Fora da faixa/);
  assert.throws(() => interpretarCron("*/0 * * * *"), /Passo inválido/);
  assert.throws(() => proximaExecucao("0 0 31 2 *", new Date("2030-01-01T00:00:00Z")), /nunca dispara/);
});
