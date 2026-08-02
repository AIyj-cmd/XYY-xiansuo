// 跟进派生仍由同一事务内的既有实现计算；此入口避免路由直接依赖具体实现文件。
export { recomputeFollowUpDerived } from './follow-up-derived.js';
