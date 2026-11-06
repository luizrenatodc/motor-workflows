type Token = { tipo: "num" | "txt" | "nome" | "op"; valor: string };

const OPERADORES = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")", "+", "-", "*", "/"];

function tokenizar(texto: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (/\s/.test(c)) { i++; continue; }
    const numero = /^\d+(\.\d+)?/.exec(texto.slice(i));
    if (numero) { tokens.push({ tipo: "num", valor: numero[0] }); i += numero[0].length; continue; }
    if (c === '"' || c === "'") {
      const fim = texto.indexOf(c, i + 1);
      if (fim < 0) throw new Error("Texto sem aspas de fechamento");
      tokens.push({ tipo: "txt", valor: texto.slice(i + 1, fim) });
      i = fim + 1;
      continue;
    }
    const nome = /^[A-Za-z_][\w.]*/.exec(texto.slice(i));
    if (nome) { tokens.push({ tipo: "nome", valor: nome[0] }); i += nome[0].length; continue; }
    const op = OPERADORES.find((o) => texto.startsWith(o, i));
    if (!op) throw new Error(`Símbolo inesperado: ${c}`);
    tokens.push({ tipo: "op", valor: op });
    i += op.length;
  }
  return tokens;
}

const ler = (contexto: unknown, caminho: string): unknown =>
  caminho.split(".").reduce<unknown>((atual, chave) => {
    if (atual === null || typeof atual !== "object" || !Object.hasOwn(atual, chave)) return undefined;
    return (atual as Record<string, unknown>)[chave];
  }, contexto);

/** Avaliador por descida recursiva. Definições de fluxo nunca passam por eval. */
export function avaliar(texto: string, contexto: unknown): unknown {
  const tokens = tokenizar(texto);
  let i = 0;
  const olhar = () => tokens[i]?.tipo === "op" ? tokens[i].valor : undefined;

  const binario = (proximo: () => unknown, ops: Record<string, (a: any, b: any) => unknown>) => () => {
    let esquerda = proximo();
    while (olhar() && olhar()! in ops) {
      const op = tokens[i++].valor;
      esquerda = ops[op](esquerda, proximo());
    }
    return esquerda;
  };

  const primario = (): unknown => {
    const t = tokens[i++];
    if (!t) throw new Error("Expressão incompleta");
    if (t.tipo === "num") return Number(t.valor);
    if (t.tipo === "txt") return t.valor;
    if (t.tipo === "nome") return t.valor === "true" ? true : t.valor === "false" ? false : t.valor === "null" ? null : ler(contexto, t.valor);
    if (t.valor === "(") {
      const v = ou();
      if (tokens[i++]?.valor !== ")") throw new Error("Falta fechar parêntese");
      return v;
    }
    if (t.valor === "!") return !primario();
    if (t.valor === "-") return -(primario() as number);
    throw new Error(`Operador fora do lugar: ${t.valor}`);
  };
  const produto = binario(primario, { "*": (a, b) => a * b, "/": (a, b) => a / b });
  const soma = binario(produto, { "+": (a, b) => a + b, "-": (a, b) => a - b });
  const comparacao = binario(soma, { ">": (a, b) => a > b, "<": (a, b) => a < b, ">=": (a, b) => a >= b, "<=": (a, b) => a <= b });
  const igualdade = binario(comparacao, { "==": (a, b) => a === b, "!=": (a, b) => a !== b });
  const e = binario(igualdade, { "&&": (a, b) => a && b });
  const ou = binario(e, { "||": (a, b) => a || b });

  const valor = ou();
  if (i < tokens.length) throw new Error(`Sobrou algo na expressão: ${tokens[i].valor}`);
  return valor;
}

/** Troca {{ expressão }} em textos e objetos. Um texto que é só a expressão mantém o tipo original. */
export function interpolar(valor: unknown, contexto: unknown): unknown {
  if (typeof valor === "string") {
    const inteiro = /^\{\{(.+?)\}\}$/.exec(valor.trim());
    if (inteiro) return avaliar(inteiro[1], contexto);
    return valor.replace(/\{\{(.+?)\}\}/g, (_, e) => String(avaliar(e, contexto) ?? ""));
  }
  if (Array.isArray(valor)) return valor.map((v) => interpolar(v, contexto));
  if (valor && typeof valor === "object") return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, interpolar(v, contexto)]));
  return valor;
}
