type L = (es: string, en: string) => string;

/** How long ago, in the largest unit that fits: «hace 3 h», never «hace 3 h 0 min». */
export function ago(iso: string, l: L): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return l("hace un momento", "just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return l(`hace ${minutes} min`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return l(`hace ${hours} h`, `${hours} h ago`);
  const days = Math.round(hours / 24);
  return days === 1 ? l("ayer", "yesterday") : l(`hace ${days} días`, `${days} days ago`);
}
