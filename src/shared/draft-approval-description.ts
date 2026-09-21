/** Update only router-authored status text on a human Draft -> Approved move. */
export function acknowledgeDraftApproval(description: string): string {
  const block = /<!-- kangentic-draft:v1 source=[a-f0-9]{64} -->[\s\S]*?<!-- \/kangentic-draft -->/gi;
  return description.replace(block, (match) => match
    .replace(/^Estado: (?:NECESITA APROBACIÓN|LISTA PARA APROBAR)\s*$/m, 'Estado: APROBACIÓN HUMANA REGISTRADA')
    .replace(/^Falta: (?:Añade la label humana approved[^\n]*|Revísala y muévela a Approved[^\n]*|Nada\.)$/m,
      'Falta: evaluar capacidad y requisitos de la tarea. No volver a pedir el GO inicial.'))
    .replace(/^Estado: propuesta sin autorización\. Edita y mueve a Approved solo si quieres ejecutarla\.$/gm,
      'Estado: GO inicial registrado. Se conservan los límites de alcance y seguridad.');
}
