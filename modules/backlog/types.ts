export type Kind = 'request' | 'task';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type Category = 'draft' | 'ready' | 'active' | 'blocked' | 'done' | 'canceled';
export type Policy = 'approval_required' | 'autonomous';
export interface ActorContext { id: string; channel: 'cli' | 'pi-command' | 'pi-tool' | 'library'; role: 'operator' | 'automation' }
export interface OperationContext { cwd: string; projectId?: string; actor: ActorContext }
export interface ServiceOptions { dataRoot: string; now?: () => number; uuid?: () => string; randomToken?: () => string }
export interface ItemReference { projectId: string; itemId: string }
export interface TextLocator { itemId: string; field: string; revision: number; recordId?: string }
export interface TextPreview { text: string; truncated: boolean; locator: TextLocator }
export interface Project { id: string; name: string; directory: string; available: boolean; registryRevision: number; createdAt: string; updatedAt: string; dataRoot: string }
export interface Item {
  projectId: string; dataRoot: string; id: string; kind: Kind; title: string;
  description: TextPreview; priority: Priority; workflowVersion: number; stage: string;
  revision: number; scopeRevision: number; createdAt: string; updatedAt: string;
  createdBy: ActorContext; updatedBy: ActorContext; parentId?: string;
}
export interface ArtifactReference { label: string; reference: string }
export interface CompletionRecord { summary: string; verification: string; evidence: ArtifactReference[] }
export interface Page<T> { items: T[]; nextCursor?: string }
// Implemented operations extend this map as their handlers are introduced.
export interface ItemFields { title?:string; description?:string; criteria?:string[]; priority?:Priority }
export interface ItemChange extends ItemFields { itemId:string; expectedRevision:number; mutationId?:string; parent?:ItemReference|null }
export interface DependencyChange { itemId:string; prerequisite:ItemReference; expectedRevision:number; mutationId?:string }
export interface OwnershipProof { leaseId:string; generation:number; token:string }
export interface RevisionInput { itemId:string; expectedRevision:number; mutationId?:string }
export interface Eligibility { eligible:boolean; category:Category; policy:EffectivePolicy; authorized:boolean; parentScopeRevision?:number; reasons:string[] }
export interface EffectivePolicy { policy:Policy; source:string; version:string; governingId:string }
export interface AuthorizationInput extends RevisionInput { rationale:string }
export interface ClaimReceipt extends OwnershipProof { worker:string;expiresAt:string;durationSeconds:number;revision:number;taskScopeRevision:number;parentScopeRevision?:number }
export interface OperationMap {
  'claim.recover': {input:RevisionInput & {leaseId:string;generation:number;reason:string};output:Item};
  'claim.renew': {input:{itemId:string;proof:OwnershipProof;mutationId?:string};output:{leaseId:string;generation:number;expiresAt:string;durationSeconds:number}};
  'claim.release': {input:RevisionInput & {proof:OwnershipProof};output:Item};
  'claim.acquire': {input:RevisionInput & {worker:string;durationSeconds?:number;expectedParentScopeRevision?:number};output:ClaimReceipt};
  'authorization.approve': {input:AuthorizationInput;output:Item};
  'authorization.authorize': {input:AuthorizationInput;output:Item};
  'authorization.revoke': {input:AuthorizationInput;output:Item};
  'project.policy': {input:{policy:Policy|null;expectedPolicyVersion:number;itemId?:string;expectedRevision?:number;mutationId?:string};output:{policy:Policy;policyVersion:number;item?:Item}};
  'note.append': {input:RevisionInput & {text:string};output:Item};
  'artifact.attach': {input:RevisionInput & {artifacts:ArtifactReference[]};output:Item};
  'result.append': {input:RevisionInput & {result:CompletionRecord;proof?:OwnershipProof};output:Item};
  'dependency.add': {input:DependencyChange;output:Item};
  'dependency.remove': {input:DependencyChange;output:Item};
  'item.add': {input:ItemFields & {kind:Kind;title:string;mutationId?:string};output:Item};
  'item.show': {input:{itemId:string};output:Item};
  'item.update': {input:ItemChange;output:Item};
  'project.rename': {input:{name:string;expectedRegistryRevision:number;mutationId?:string};output:Project};
  'project.relocate': {input:{directory:string;expectedRegistryRevision:number;mutationId?:string};output:Project};
  'project.register': {input:{directory:string;name:string;mutationId?:string};output:Project};
  'project.list': {input:Record<string,never>;output:Page<Project>};
  'project.show': {input:Record<string,never>;output:Project};
}
export interface BacklogService {
  execute<K extends keyof OperationMap>(context: OperationContext, operation: K, input: OperationMap[K] extends {input: infer I} ? I : never): OperationMap[K] extends {output: infer O} ? O : never;
  close(): void;
}
