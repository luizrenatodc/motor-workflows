import { setTimeout as pausar } from "node:timers/promises";
import type { Fluxo } from "./grafo.ts";
import type { Acao } from "./motor.ts";

const lento = (ms: number) => pausar(ms + Math.floor(Math.random() * 60));

export const ACOES: Record<string, Acao> = {
  validar: async ({ documento }) => {
    await lento(120);
    if (!documento) throw new Error("Documento ausente");
    return { valido: true };
  },
  credito: async ({ documento, instavel }, { tentativa }) => {
    await lento(260);
    if (instavel && tentativa < 3) throw new Error("Bureau de crédito indisponível (503)");
    return { score: Number(String(documento).slice(-3)) };
  },
  antifraude: async () => { await lento(340); return { risco: "baixo" }; },
  criar_conta: async ({ cliente }) => { await lento(180); return { conta: `CT-${String(cliente).length}${Date.now() % 1000}` }; },
  revisao: async () => { await lento(90); return { fila: "analise-manual" }; },
  notificar: async ({ mensagem }) => { await lento(70); return { enviado: mensagem }; },
  extrair: async () => { await lento(220); return { linhas: 1840 }; },
  transformar: async ({ linhas }) => { await lento(300); return { linhas, rejeitadas: 12 }; },
  carregar: async ({ falhar }) => { await lento(160); if (falhar) throw new Error("Conexão recusada pelo banco"); return { ok: true }; },
};

export const FLUXOS: Fluxo[] = [
  {
    id: "onboarding",
    nome: "Onboarding de cliente",
    passos: [
      { id: "validar", acao: "validar", params: { documento: "{{ entrada.documento }}" } },
      { id: "credito", acao: "credito", depende: ["validar"], params: { documento: "{{ entrada.documento }}", instavel: "{{ entrada.instavel }}" }, tentativas: 3, esperaMs: 120, limiteMs: 2000 },
      { id: "antifraude", acao: "antifraude", depende: ["validar"] },
      { id: "criar_conta", acao: "criar_conta", depende: ["credito", "antifraude"], se: "passos.credito.saida.score >= 600", params: { cliente: "{{ entrada.cliente }}" } },
      { id: "revisao", acao: "revisao", depende: ["credito", "antifraude"], se: "passos.credito.saida.score < 600" },
      { id: "avisar", acao: "notificar", depende: ["criar_conta", "revisao"], juncao: true, params: { mensagem: "Olá {{ entrada.cliente }}, seu cadastro foi processado." } },
    ],
  },
  {
    id: "etl-noturno",
    nome: "Carga noturna de vendas",
    passos: [
      { id: "extrair", acao: "extrair" },
      { id: "transformar", acao: "transformar", depende: ["extrair"], params: { linhas: "{{ passos.extrair.saida.linhas }}" } },
      { id: "carregar", acao: "carregar", depende: ["transformar"], params: { falhar: "{{ entrada.falhar }}" }, tentativas: 2, esperaMs: 100 },
      { id: "avisar", acao: "notificar", depende: ["carregar"], params: { mensagem: "Carga concluída" } },
    ],
  },
];

export const ENTRADAS: [string, unknown][] = [
  ["etl-noturno", {}],
  ["onboarding", { cliente: "Marina", documento: "1234567420" }],
  ["etl-noturno", { falhar: true }],
  ["onboarding", { cliente: "Paulo", documento: "1234567810", instavel: true }],
];
