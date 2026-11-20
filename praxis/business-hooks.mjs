const error = (status, code) => Object.assign(new Error(code), { status, code });
export function createBusinessHooks() {
  return {
    normalizeAdapterRequest(request) {
      const result = { ...request };
      if (request.operation === 'list_assignments' && !result.resourceId) result.resourceId = 'assignments';
      if (result.expectedRevision !== undefined) {
        if (!/^(0|[1-9]\d*)$/.test(String(result.expectedRevision)) || !Number.isSafeInteger(Number(result.expectedRevision))) throw error(400, 'INVALID_REVISION');
        result.expectedRevision = Number(result.expectedRevision);
      }
      return result;
    },
    projectResult: (request, result, ctx) => request.operation === 'get_assignment' ? { ...result, permissions: { submit: ctx.hasAction('submit') } } : result,
  };
}
