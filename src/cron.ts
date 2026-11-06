const FAIXAS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function campo(texto: string, [minimo, maximo]: [number, number]): Set<number> {
  const valores = new Set<number>();
  for (const parte of texto.split(",")) {
    const [faixa, passoTexto] = parte.split("/");
    const passo = passoTexto === undefined ? 1 : Number(passoTexto);
    if (!Number.isInteger(passo) || passo < 1) throw new Error(`Passo inválido: ${parte}`);
    const [de, ate] = faixa === "*" ? [minimo, maximo] : faixa.includes("-") ? faixa.split("-").map(Number) : [Number(faixa), passoTexto ? maximo : Number(faixa)];
    if (!(de >= minimo && ate <= maximo && de <= ate)) throw new Error(`Fora da faixa: ${parte}`);
    for (let v = de; v <= ate; v += passo) valores.add(v);
  }
  return valores;
}

export function interpretarCron(expressao: string) {
  const partes = expressao.trim().split(/\s+/);
  if (partes.length !== 5) throw new Error("Use 5 campos: minuto hora dia mês dia-da-semana");
  const [minuto, hora, dia, mes, semana] = partes.map((p, i) => campo(p, FAIXAS[i]));
  return { minuto, hora, dia, mes, semana, diaLivre: partes[2] === "*", semanaLivre: partes[4] === "*" };
}

/** Próximo disparo em UTC, sempre depois de `apos`. Como no cron padrão, dia e dia da semana combinam com OU quando ambos são definidos. */
export function proximaExecucao(expressao: string, apos: Date): Date {
  const c = interpretarCron(expressao);
  const d = new Date(apos);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limite = apos.getTime() + 5 * 366 * 86_400_000;
  while (d.getTime() < limite) {
    const diaOk = c.diaLivre || c.semanaLivre ? c.dia.has(d.getUTCDate()) && c.semana.has(d.getUTCDay()) : c.dia.has(d.getUTCDate()) || c.semana.has(d.getUTCDay());
    if (!c.mes.has(d.getUTCMonth() + 1) || !diaOk) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0);
    } else if (!c.hora.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0);
    } else if (!c.minuto.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1);
    } else {
      return d;
    }
  }
  throw new Error("Expressão nunca dispara");
}
