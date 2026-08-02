import { computed, ref } from 'vue';

/** 两个线索列表共用的分页与筛选状态；请求参数仍由各页面按业务边界组装。 */
export function useLeadListState<T>() {
  const items = ref<T[]>([]);
  const loading = ref(false);
  const refreshing = ref(false);
  const page = ref(1);
  const total = ref(0);
  const hasMore = computed(() => items.value.length < total.value);
  const keyword = ref('');
  const showFilter = ref(false);
  const sortMode = ref<'last_follow' | 'next_follow' | 'created_new'>('last_follow');
  const filterDate = ref('');
  const filterStatus = ref<string[]>([]);
  const filterSource = ref('');
  const filterIndustry = ref('');
  const filterIntent = ref('');

  function resetPagination() {
    page.value = 1;
    items.value = [];
  }

  function resetFilters() {
    filterStatus.value = [];
    filterSource.value = '';
    filterIndustry.value = '';
    filterIntent.value = '';
  }

  return {
    items, loading, refreshing, page, total, hasMore, keyword, showFilter,
    sortMode, filterDate, filterStatus, filterSource, filterIndustry, filterIntent,
    resetPagination, resetFilters,
  };
}
