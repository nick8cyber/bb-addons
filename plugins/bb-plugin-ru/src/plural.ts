/**
 * Русские числительные: «1 подпись», «2 подписи», «5 подписей».
 *
 * Свой интерфейс плагина обязан быть грамотным — иначе странно требовать
 * качества от перевода.
 */
export function plural(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** «5 строк» — число вместе с согласованным словом. */
export function pluralize(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  return `${count} ${plural(count, one, few, many)}`;
}
