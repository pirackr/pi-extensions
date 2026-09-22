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
export interface OperationMap {}
export interface BacklogService {
  execute<K extends keyof OperationMap>(context: OperationContext, operation: K, input: OperationMap[K] extends {input: infer I} ? I : never): OperationMap[K] extends {output: infer O} ? O : never;
  close(): void;
}
