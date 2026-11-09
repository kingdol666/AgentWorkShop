# 记账软件需求规格 v1
## 功能
1. 记账:add <金额> <分类> [备注] —— 正数=收入,负数=支出,落 JSON 文件
2. 汇总:summary —— 返回 {count, income, expense, balance}
3. 分类统计:by-category —— 按分类聚合净额
## 数据格式
[{date, amount, category, note}] , date=ISO 日期, amount=正负浮点
## 验收
- summary.balance = income - expense(两位小数)
- by-category 净利润分类正确聚合
