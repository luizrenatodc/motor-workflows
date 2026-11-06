export type Passo = {
  id: string;
  acao: string;
  depende?: string[];
  params?: Record<string, unknown>;
  se?: string;
  tentativas?: number;
  esperaMs?: number;
  limiteMs?: number;
  /** Roda quando ao menos uma dependência terminou com sucesso. Serve para juntar ramos condicionais. */
  juncao?: boolean;
};

export type Fluxo = { id: string; nome: string; passos: Passo[] };

/** Ordena em camadas pelo algoritmo de Kahn e recusa IDs repetidos, dependências soltas e ciclos. */
export function camadas(passos: Passo[]): string[][] {
  const ids = new Set(passos.map((p) => p.id));
  if (ids.size !== passos.length) throw new Error("Há passos com o mesmo id");
  const faltando = new Map(passos.map((p) => [p.id, new Set(p.depende ?? [])]));
  for (const p of passos) {
    for (const d of p.depende ?? []) if (!ids.has(d)) throw new Error(`${p.id} depende de ${d}, que não existe`);
  }
  const resultado: string[][] = [];
  while (faltando.size) {
    const prontos = [...faltando].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!prontos.length) throw new Error(`Ciclo entre: ${[...faltando.keys()].join(", ")}`);
    resultado.push(prontos);
    for (const id of prontos) faltando.delete(id);
    for (const deps of faltando.values()) for (const id of prontos) deps.delete(id);
  }
  return resultado;
}
