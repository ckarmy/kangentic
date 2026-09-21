/** A response is not approval for a new scope or for a dangerous operation. */
export function humanResponseResumeBlock(input: {
  labels: string[];
  description: string;
  archived: boolean;
  columnName: string;
}): string | null {
  const labels = new Set(input.labels.map((label) => label.trim().toLowerCase()));
  if (input.archived) return 'Restaura la tarjeta antes de reanudar.';
  if (!/^(planning|executing|review|code review|verify|testing)$/i.test(input.columnName)) return 'Esta columna no es una etapa de ejecución.';
  if (labels.has('manual-hold') || labels.has('no-auto')) return 'Hay una pausa manual. Revisa su motivo antes de retirarla.';
  if (labels.has('production') && !labels.has('go-ck')) return 'La tarea está marcada producción. Requiere una autorización específica, no solo responder una pregunta.';
  if (!labels.has('approved')) return 'Falta la aprobación inicial de esta tarea.';
  if (labels.has('needs-info')) return 'Guarda primero la información solicitada.';
  if (!labels.has('needs-human')) return 'Esta tarjeta ya no está esperando una reanudación humana.';
  const questionPosition = input.description.lastIndexOf('\n## Información requerida');
  const responsePosition = input.description.lastIndexOf('\n## Respuesta humana');
  if (responsePosition < 0 || responsePosition < questionPosition) return 'Falta una respuesta a la última pregunta.';
  return null;
}
