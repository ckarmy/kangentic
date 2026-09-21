import type { CommandHandler } from './types';

export const handleGetDeliveryOperation: CommandHandler = (params, context) => {
  if (context.actor !== 'human') return { success: false, error: 'Human action is required' };
  if (typeof params.taskId !== 'string' || !params.taskId.trim() || typeof params.operationId !== 'string'
      || !/^[a-zA-Z0-9-]{16,128}$/.test(params.operationId)) return { success: false, error: 'Task and operation identity are required' };
  if (!context.readDeliveryOperation) return { success: false, error: 'Delivery operation reader is unavailable' };
  return { success: true, data: context.readDeliveryOperation(params.taskId, params.operationId) };
};

/** Human transport only; never exposed as public MCP tools. Both are read-only. */
export const handlePrepareTaskDelivery: CommandHandler = async (params, context) => {
  if (context.actor !== 'human') return { success: false, error: 'Human action is required' };
  if (typeof params.taskId !== 'string' || !params.taskId.trim()) return { success: false, error: 'taskId is required' };
  if (!context.prepareTaskDelivery) return { success: false, error: 'Delivery preview is unavailable' };
  return { success: true, data: await context.prepareTaskDelivery(params.taskId) };
};

export const handlePrepareTaskPush: CommandHandler = async (params, context) => {
  if (context.actor !== 'human') return { success: false, error: 'Human action is required' };
  if (typeof params.taskId !== 'string' || !params.taskId.trim()) return { success: false, error: 'taskId is required' };
  if (!context.prepareTaskPush) return { success: false, error: 'Push preview is unavailable' };
  return { success: true, data: await context.prepareTaskPush(params.taskId) };
};
