// 负责人变更继续委托既有原子实现，供 HTTP 路由只保留认证、校验与响应职责。
export { assertActiveOwner, OwnerTransferError, transferLeadOwner } from './lead-owner.js';
