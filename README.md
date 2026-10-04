# 森林防火巡护管理系统

面向森林火险监测、巡护任务调度、防火设施维护与应急响应指挥的林区防火管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/coverage-service.ts 覆盖归档台服务：名册导入、归档、批次续跑、报告
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   │   ├── coverage-store.ts     归档事务：覆盖状态与业务清单跨键提交、整体回退
│   │   └── coverage-archive.ts   归档引擎：日期补归属、三写入、断点续跑、并发去重、报告
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 巡护任务 | `patrol` | 巡护任务 | 任务编号、巡护区域、巡护路线 |
| 火险监测 | `firewatch` | 火险监测点 | 监测点编号、监测区域、火险等级 |
| 瞭望台管理 | `lookout` | 瞭望台 | 瞭望台编号、所在山头、海拔高度 |
| 防火隔离带 | `firebreak` | 防火隔离带 | 隔离带编号、所属林区、起止坐标 |
| 扑火队伍 | `fireteam` | 扑火队伍 | 队伍编号、队伍名称、所属林场 |
| 消防装备 | `equipment` | 消防装备 | 装备编号、装备名称、装备类型 |
| 气象观测 | `weather` | 气象观测记录 | 记录编号、观测站点、观测时间 |
| 火情报告 | `firereport` | 火情报告 | 报告编号、起火地点、起火时间 |
| 无人机巡查 | `drone` | 无人机巡查任务 | 任务编号、飞行区域、飞行路线 |
| 防火宣传 | `campaign` | 防火宣传活动 | 活动编号、宣传主题、宣传方式 |
| 覆盖归档台 | `coverage` | 宣传覆盖归档 | 村组名单、归档批次、受众/方式报告 |
| 防火检查站 | `checkpoint` | 防火检查站 | 站点编号、站点位置、值守人员 |
| 值勤排班 | `duty` | 值勤排班表 | 排班编号、值勤日期、值勤时段 |
| 物资储备 | `supply` | 防火物资 | 物资编号、物资名称、物资类别 |
| 林区道路 | `forestroad` | 林区道路 | 道路编号、道路名称、起点位置 |
| 防火林带 | `firebelt` | 防火林带 | 林带编号、林带名称、所属林区 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练主题、参演队伍 |
| 焚烧审批 | `burnpermit` | 用火审批单 | 审批编号、申请单位、用火类型 |
| 林木生长 | `treegrowth` | 林木生长记录 | 记录编号、样地编号、林分类型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `forest-fire-patrol:entries` 这一项，或调用 `resetModule(模块)`。

## 覆盖归档台

防火宣传新增「覆盖归档台」（导航：覆盖归档台，`/coverage`），沿既有的
**防火宣传 → 覆盖村组 → 林区道路沿线 / 防火检查站** 数据流工作：

- **导入村组名单**：CSV（`村组,受众人数`，页面可下载模板）。同一活动重复导入时
  **以新文件为准**——新名单整体替换历史名册；已归档结果是历史事实，不随新名单改写。
- **旧记录补归属**：活动缺少覆盖村组时，按活动日期稳定地补到名册中的某个村组
  （同一日期总是落到同一村），归档结果里标注来源是「名册」还是「日期补归属」。
- **归档三写入**：宣传活动状态置为已完成、生成林区道路沿线提示清单、检查站宣传提醒，
  三笔写入在同一事务里提交，任一阶段失败（或持久化失败）整体回退到事务前。
- **道路提醒清单同步宣传状态**：防火宣传页面的状态动作也走同一事务，道路与检查站提示
  清单里的宣传状态跟着更新，不会两边对不上。
- **批次处理**：可归档活动按编号批量归档；某笔失败回退并中断批次后，再次执行自动
  从未归档活动继续（已取消的活动跳过）。
- **并发只一份结果**：批次在途时并发触发只兑现同一个 Promise；没有新的未归档活动时
  重复操作复用上一版结果，不生成第二版；同一活动重复归档直接拒绝。
- **报告下载**：受众人数报告（按覆盖村组汇总）与宣传方式分布报告（含占比），CSV 下载。
- 归档状态单独存在浏览器 `forest-fire-patrol:coverage` 键里，与业务清单
  `forest-fire-patrol:entries` 一起在归档事务中提交。

行为验证脚本在 `frontend/scratch/verify-coverage.ts`（不参与构建），用内存 KV 模拟
localStorage，通过 esbuild 打包后由 Node 执行：

```bash
cd frontend
node --input-type=module -e "import esbuild from 'esbuild';const r=await esbuild.build({entryPoints:['scratch/verify-coverage.ts'],bundle:true,format:'esm',platform:'node',write:false,alias:{'@':'./src'}});await import('data:text/javascript,'+encodeURIComponent(r.outputFiles[0].text))"
```
