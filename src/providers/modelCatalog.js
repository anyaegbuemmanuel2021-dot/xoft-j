/**
 * validateModelChoice — decides whether a client-requested model id may be
 * selected. Fails CLOSED: if the provider catalog is empty/unavailable we
 * cannot verify the id, so it is rejected (previously an empty catalog let any
 * non-empty string through, which is exactly the "accept arbitrary string,
 * fail later mid-task" weakness).
 * @returns {{ok:true}|{ok:false,status:number,error:string}}
 */
export function validateModelChoice(catalog, model, provider = 'experiential') {
  const ids = new Set((Array.isArray(catalog) ? catalog : []).map((e) => e?.id ?? e?.slug).filter(Boolean));
  if (ids.size === 0) return { ok: false, status: 502, error: `The ${provider} model catalog is empty or unavailable, so '${model}' cannot be verified.` };
  if (!ids.has(model)) return { ok: false, status: 400, error: `'${model}' is not in the ${provider} model catalog for this API key` };
  return { ok: true };
}
