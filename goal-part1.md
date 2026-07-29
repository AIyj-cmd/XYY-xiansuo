工作目录/home/yj/xiansuo，改完每个模块执行cd /home/yj/xiansuo/app&&npm run build:h5，按顺序完成以下4个模块，每个测试通过再进下一个。

【模块1】意向等级圆点
改app/src/pages/leads/list.vue：卡片第一行公司名左侧加8px圆点，高=#E53E3E 中=#DD6B20 低=#2F855A 未知=#A0AEC0，flex-shrink:0 border-radius:50%。
验收：圆点颜色正确；不影响布局；intent_level为空显示灰点不报错；build通过。

【模块2】最近跟进相对时间
加relativeTime函数：今天/昨天/N天前/N周前/N月前，基于Asia/Shanghai时区。第四行改为「N天前·内容摘要」，颜色#A0AEC0。
验收：今天显示"今天"，昨天显示"昨天"；last_follow_content为null时整行不渲染；超长摘要单行截断；build通过。

【模块3】逾期颜色三档
1-3天：bg=#FFF3CD border=#F6AD55 color=#C05621；4-7天：bg=#FFF5F5 border=#FC8181 color=#C53030；8天+：bg=#FED7D7 border=#E53E3E color=#9B2C2C font-weight:700。用:class动态绑定。
验收：三档颜色差异明显；overdueDays=0不触发逾期样式；已成交/已流失不显示逾期标签；build通过。

【模块4】手机号一键拨打
第二行手机号后加📞按钮，点击调用utils/call.ts拨号，加stopPropagation防止跳详情。
验收：点图标触发拨号不跳详情；点卡片其他区域正常进详情；phone为空时图标不渲染；build通过。
