import { createBusinessHooks } from './praxis/business-hooks.mjs';
import { createWebIntegration } from './praxis/web.mjs';
import { createStorageIntegration } from './praxis/storage.mjs';
import { createDeploymentIntegration } from './praxis/deployment.mjs';

export function createIntegration({ z }) {
const businessError=(status,code)=>Object.assign(new Error(code),{status,code});
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const common = { spaceId: id }, mutation = { ...common, idempotencyKey: id };
const tingproofTarget = { ...mutation, resourceId: id, expectedRevision: z.number().int().nonnegative() };
function planningInput(schema, args) {
  const { spaceId: ignoredSpace, resourceId: ignoredResource, expectedRevision: ignoredRevision, idempotencyKey: ignoredKey, ...input } = args;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw businessError(400, 'INVALID_INPUT');
  return parsed.data;
}

const operationActions={"list_assignments":"read","get_assignment":"read","events":"read","submit_corrections":"submit","create_assignment":"assign","revoke_assignment":"assign"};
const operations=Object.fromEntries(Object.entries(operationActions).map(([name,action])=>[name,{action,mutation:action!=='read'}]));
operations.list_assignments.adapterResourceId='assignments';
const observedCapabilities={"list_assignments":"read","get_assignment":"read","events":"read","submit_corrections":"update","create_assignment":"create","revoke_assignment":"delete"};
for(const [name,definition]of Object.entries(operations))definition.capability=observedCapabilities[name];
function validateInvocation(request) {
const {appId,operation,spaceId,resourceId}=request;const action=operationActions[operation];
if(request.sourceResourceId!==undefined)throw businessError(400,'INVALID_REQUEST');
if(['get_assignment','submit_corrections','revoke_assignment'].includes(operation)&&!resourceId)throw businessError(400,'RESOURCE_REQUIRED');

}
return {schemaVersion:1,appId:"tingproof",web:createWebIntegration(),storage:createStorageIntegration(),deployment:createDeploymentIntegration(),business:{adapterId:"tingproof",actions:["read","submit","assign"],scopes:{"tingproof:read":["read"],"tingproof:write":["submit","assign"]},targetedCreate:false,operations,tools:[
{ name: 'tingproof_list_assignments', appId: 'tingproof', operation: 'list_assignments', action: 'read', description: 'List only assignments visible in one explicitly authorized space.', schema: z.object(common).strict() },
{ name: 'tingproof_get_assignment', appId: 'tingproof', operation: 'get_assignment', action: 'read', description: 'Read only the segments included in one authorized TingProof assignment.', schema: z.object({ ...common, resourceId: id }).strict() },
{ name: 'tingproof_submit_corrections', appId: 'tingproof', operation: 'submit_corrections', action: 'submit', description: 'Submit corrections to assigned segments only; rejects stale versions and duplicate keys with different inputs.', schema: z.object({ ...tingproofTarget, corrections: z.array(z.object({ segmentId: id, correctedText: z.string().max(100000), status: z.enum(['unreviewed', 'editing', 'questioned', 'confirmed', 'accepted_unclear']).optional() }).strict()).min(1).max(200) }).strict(), input: args => ({ corrections: args.corrections }) },
{ name: 'tingproof_create_assignment', appId: 'tingproof', operation: 'create_assignment', action: 'assign', description: 'Create an assignment within the caller’s authorized project and space. Requires assignment-management permission.', schema: z.object({ ...tingproofTarget, projectId: id, segmentIds: z.array(id).min(1).max(1000), title: z.string().max(160).optional(), expiresAt: z.number().int().positive().optional() }).strict(), input: args => Object.fromEntries(['projectId', 'segmentIds', 'title', 'expiresAt'].filter(k => args[k] !== undefined).map(k => [k, args[k]])) }
],skill:{name:"mcp-tingproof",path:"skills/mcp-tingproof/SKILL.md"},instructions:[],validateInvocation,...createBusinessHooks({}),schemas:{},events:{operation:'events',resourceId:'events'}}};
}
