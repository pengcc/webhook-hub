# webhook-hub 决策记录（2026-11-15）

目标：作品集项目，也对应真实外包需求。展示 webhook 接收的签名校验、幂等去重、失败重试、入库，加一个只读看板。

## 已定

| 项 | 决定 |
|---|---|
| 后端 | Node + TypeScript，Fastify，`pg`（查询层见"待定"），zod，pino，vitest（集成测试连真实 Postgres） |
| 队列 | Postgres 自身（`FOR UPDATE SKIP LOCKED`），不用 Redis |
| 数据库 | Postgres，每个项目独立数据库和用户；看板 API 用只读角色 |
| 前端看板 | `pengcc/portfolio` 内的路由（如 `/demos/webhook-hub`），Cloudflare Pages，只调用只读 API，`VITE_API_BASE` 构建时注入 |
| 降级 | API 不通时显示构建时生成的静态快照，并标注 live API 暂不可用 |
| 后端部署 | Oracle VPS，Docker Compose（caddy / webhook-hub / postgres，均有 arm64 镜像） |
| 反向代理 | Caddy，按子域名分发，HTTP-01 自动签证书，需放行 80/443（OCI Security List + 主机 iptables 都要改） |
| 主机名 | 先用 DuckDNS 子域名（暂时可用即可），将来换域名只改 Caddy 主机名和 `VITE_API_BASE` |
| 演示数据 | 先做模拟发送器（Shopify 格式，可制造错签名、重复、下游失败）；Shopify 开发商店是可选的锦上添花 |
| 数据标注 | 看板用 `source` 区分 `synthetic` / `shopify-dev`，不接真实客户数据 |
| 密钥 | 只放 VPS 的 `.env`，仓库只有 `.env.example` |

## 关键设计

- 签名：Shopify `X-Shopify-Hmac-Sha256`，对原始 body 做 HMAC-SHA256 再 base64，`timingSafeEqual` 比较；通用来源加时间戳窗口防重放。
- 幂等：`UNIQUE(source, event_id)` + `INSERT … ON CONFLICT DO NOTHING`，重复投递也返回 200。Shopify 的 `event_id` 取 `X-Shopify-Webhook-Id`（同一次投递的重试保持不变）；`X-Shopify-Event-Id` 只存入 `correlation_id`，不用于去重，因为同一商家操作触发多个订阅时它们共享该 ID，用它去重会丢事件。依据：Shopify 官方 "ignore duplicates" 文档（经搜索摘要核对，未逐字阅读原文）。
- 先落库再处理：验签、入库后立即 2xx，worker 异步处理。
- 重试：`attempts`、`next_attempt_at`、指数退避加抖动，超限转 `dead`。
- 看板 API：`GET /events`、`/events/:id`、`/stats`；限流；CORS 只允许 portfolio 的 Origin；重放按钮不放公网。
- 可观察性：结构化日志、`/healthz`、简单 `/metrics`。
- 公网入口防护：`/webhooks/*` 限制 body 大小（如 1 MB）并限流，验签失败返回 401 且不落 payload。
- 网络暴露：只有 Caddy 监听 80/443；Postgres 和 Node 服务只在 Compose 内部网络，不映射宿主端口；SSH 保持仅密钥登录。
- 主机防火墙：OCI 的 Ubuntu 镜像用 `/etc/iptables/rules.v4`（netfilter-persistent），在已有 REJECT 规则之前插入 80/443 的 ACCEPT，不要另启 ufw 叠加。

## 已核实 / 未核实

- 已核实：OCI Cost Analysis 截至 2026-11-15 各项（Compute、Block Storage、Object Storage、VCN、Telemetry）均为 €0.00；账单数据约有 24 小时延迟。
- 已核实：`duckdns.org` 在 Public Suffix List 中，Let's Encrypt 限额按子域名独立计算；DuckDNS 官网当前可访问。`sslip.io` 不在该列表中，限额与其他用户共用，不作为首选。
- 未核实：在本 VPS 上用 Caddy 实际签发 DuckDNS 证书（要等 80 端口放行后再试）；DuckDNS 长期稳定性（个人运营，无 SLA）；Shopify Partner / 开发商店当前条款（注册时以页面为准）；Shopify 真实投递的请求头是否与上述一致（目前只用本地签名请求测试过，要等开发商店或真实投递来验证）。
- 闲置回收：Always Free 的回收规则可能覆盖常驻的小服务，官方文档未确认 PAYG 是否豁免，不作保证。部署轻量服务本身不会让 CPU、网络、内存的第 95 百分位超过 20%，所以"尽快部署"不能当作防回收手段。缓解办法是整个环境写成 compose 加备份加 runbook，能在新实例上重建。

## 待定

- 查询层：目前骨架直接用 `pg` 加手写 SQL 迁移（`migrations/*.sql` 加极简迁移器）。是否引入 Drizzle（自带 drizzle-kit，招聘需求常见）或 Kysely，等写到只读 API 和 worker、查询变多时再定。
- Compose 布局：Caddy 和 Postgres 是 webhook-hub 与 DealWatch 共用的基础设施。建议 VPS 上单独一个 `infra` compose（caddy + postgres + 共享外部网络 `edge`），各项目 compose 只含自己的服务并接入该网络；`infra` 的配置先放在 webhook-hub 仓库的 `deploy/infra/` 下，等 DealWatch 加入时再决定是否拆出去。

## Tooling 迁移（来自 badminton-club-app）

来源：`badminton-club-app` commit `0849b529`（2026-11-05），拷贝后在本仓库维护，不做同步。`agent-project-foundation-kit` 已弃用，不作为来源。

- 已迁移：`.repo-tools/scripts/` 下的 safety-guard（密钥扫描）及其依赖和测试、`.github/workflows/repository-safety.yml`、`biome.json`（去掉 Next/Tailwind 相关项）、`mise.toml`（Node 24、pnpm 11.26.0）、`.claude/settings.json`（最初照搬 badminton 的 deny `gh pr create/merge`，后改为：`gh pr create` 允许；`gh pr merge`、`git push`、`gh repo create` 每次询问；GitHub MCP 的 PR 创建和合并工具与自动合并开关仍禁止。原因：badminton 的 deny 配套有自己的发布脚本，这里没有，deny 只会挡住唯一的路径）、精简版 `AGENTS.md` / `CLAUDE.md`。
- 已验证：`pnpm check` 通过；`pnpm test` 27 项通过。
- 部分验证：仓库已于 2026-11-15 创建（`pengcc/webhook-hub`，公开，MIT）并推送 `main`。`pnpm safety:guard` 在 `main` 上扫描 0 个文件；在 `feat/service-skeleton` 上第一次真实扫描（22 个文件）就拦下了 README、`compose.yaml`、测试辅助文件里带密码的数据库 URL（`credential-bearing-url`，均为本地开发的一次性值，但扫描器不区分，且该规则不识别 URL 里的占位符）。处理方式：不放宽扫描器，改为 URL 不含凭据、密码走 `PGPASSWORD`（`pg` 会读取它），修改后扫描通过。CI workflow 只在 pull request 上触发，尚未在 GitHub 上运行过。
- `Dockerfile` 已在骨架里写好（多阶段、pnpm 缓存挂载、仅生产依赖、非 root `node` 用户、HEALTHCHECK），见下一节验证结果。
- 不迁移：IONOS / nginx / Mongo 相关部署与备份脚本、dev-session 和 local-production 脚本、分支和 worktree 清理、Task State / Project Memory / goal-mode、Next.js 和 TanStack 专用 skills。部署和备份思路（部署前检查、回滚、备份验证）在 Oracle + Caddy + Postgres 上重写。

## 骨架实现状态（分支 `feat/service-skeleton`，2026-11-15，尚未合并）

- 已实现：`GET /healthz`；`POST /webhooks/shopify`（先验签，失败返回 401 且不落库；缺投递头或 JSON 非法返回 400；入库幂等；body 上限 1 MiB）；`migrations/001_events.sql`（`events` 表，状态 `pending/processing/done/failed/dead`，`attempts`，`next_attempt_at`，唯一约束 `(source, event_id)`）；zod 环境变量校验（错误只报变量名）；日志脱敏签名头。
- 已验证：`pnpm typecheck` 和 `pnpm check` 通过；`pnpm test:service` 15 项通过，针对真实 Postgres 17，包括 10 个并发相同投递只落 1 行；变异检查：把验签改成恒为真、去掉唯一约束，相应测试都会失败，恢复后全部通过。Docker 镜像构建成功（arm64，约 374 MB，非 root）；容器连本地 Postgres 做了冒烟测试：合法签名 200 accepted、重复 200 duplicate、错误签名 401，库中只有 1 行。
- 数据库凭据约定：`DATABASE_URL` 不含密码，密码放 `PGPASSWORD`（VPS 的 `.env` 同理，见 `.env.example`）。已验证：容器用不含密码的 URL 加 `PGPASSWORD` 能连库并入库。
- 观察到一次未解释的现象：一次测试运行时本地 Postgres 容器不在运行（`ECONNREFUSED`），重启后全部通过；原因不明，没有更多证据说明测试本身不稳定。
- 未实现：worker、重试和死信、只读 API、CORS、限流（目前只限制了 body 大小）、`/metrics`、DuckDNS 和 Caddy、VPS 部署。
- 未验证：GitHub CI 在 PR 上的运行；在 Oracle ARM 主机上运行（本机 Mac 也是 arm64，但不是同一环境）；Shopify 真实投递。

## CI 与流程取舍

- 迁来的 `repository-safety.yml` 只跑密钥扫描和 Biome，不跑类型检查、测试、构建，所以它的绿色对服务本身说明力很弱。已新增 `.github/workflows/ci.yml`：Postgres 17 服务容器，依次 `pnpm typecheck`、`pnpm test`（repo-tools 和服务两套）、`pnpm build`。收益是：在干净环境复现（`--frozen-lockfile`、全新数据库）、防止忘跑、让将来的必需检查有意义。局限：开发者本机已跑过同样的检查，CI 抓的是环境差异和遗漏，不是新类型的 bug。
- 暂不加 Docker 构建：GitHub 默认运行器是 x86，部署目标是 ARM，构建通过不能证明目标环境没问题；等有自动部署再加（公开仓库可用免费 ARM 运行器，标签和限额未核实）。
- 未迁移 badminton 的 Issue、Plan、Review、Merge 流程（`implementation-review`、`open-or-update-pr`、`merge-pr` 等）：对单人作品集过重。这是有意取舍，而不是遗漏。待定：是否在 `AGENTS.md` 里加一小段 review 约定（合并前独立一轮审查 PR diff，问题在同一 PR 修，合并由用户决定）。
- 密钥扫描：自带约 1670 行迁移来的代码；更通用的做法是 CI 里用 gitleaks。待定：保留还是替换。GitHub 自带的 Secret Scanning 和 push protection 已开启。

## 备选（未采用）

- 全 Cloudflare（Workers + D1 + Queues，`*.workers.dev`）：零成本零运维，但技术栈变成 Workers + SQLite，与 Node + Postgres 的外包场景不符，也不适合 DealWatch 这类常驻服务。
- 买域名：每年几欧，地址更稳定，之后可迁移。
- Cloudflare Tunnel：不开入站端口，但需要域名托管在 Cloudflare。

## 推进顺序

先打通端到端的最小骨架，尽早验证还没核实的部署链路（DuckDNS + Caddy 证书 + 防火墙），再往里加功能。

1. 最小骨架（本地）：Fastify 服务，`/healthz` 加 `POST /webhooks/shopify`（验签 + 幂等入库），一条迁移，一组测试；Compose 本地能跑。
2. VPS 基础设施：装 Docker；放行 80/443（OCI Security List + iptables）；注册 DuckDNS；起 `infra`（Caddy + Postgres）；确认证书签发成功、`https://<名字>.duckdns.org/healthz` 可访问。
3. 部署骨架：创建 GitHub 仓库并推送，在 VPS 上部署，用模拟发送器从外网打一次。
4. 功能补齐：worker、重试、死信，只读 API，CORS，限流。
5. portfolio 加看板和降级快照。
6. 运维：`pg_dump` 每日备份到 Object Storage，做一次恢复演练；日志轮转，镜像定期 prune；容器内存限制（Postgres 约 512 MB，Node 约 256 MB，Caddy 约 64 MB）。
7. 可选：接 Shopify 开发商店，在 README 放截图或录屏。

## 对外动作（每次先征求同意）

创建 GitHub 仓库、推送、部署、注册 DuckDNS / Shopify Partner 等账号。Oracle 控制台由用户自己操作，Claude 只给出选项。

## 待办

- ~~1 到 2 天后再看一次 OCI Cost Analysis~~：2026-11-15 已确认 €0。部署后（尤其开始用 Object Storage 备份后）再看一次。
- 容量与风险：这台机器约放 5 到 10 个小服务；系统盘小，只有一个公网 IP，单机无冗余。README 里直接写明。
