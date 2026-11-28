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
| 反向代理 | Caddy，HTTP-01 自动签证书，需放行 80/443（OCI Security List + 主机 iptables 都要改）；目前只服务一个主机名（`lab-2026.duckdns.org`）放在根路径，多个项目怎么共用同一个主机名见"待定" |
| 主机名 | 先用 DuckDNS 子域名（暂时可用即可），已注册 `lab-2026.duckdns.org`；将来换域名只改 Caddy 主机名和 `VITE_API_BASE` |
| 演示数据 | 先做模拟发送器（Shopify 格式，可制造错签名、重复、下游失败）；Shopify 开发商店是可选的锦上添花 |
| 数据标注 | 看板用 `source` 区分 `synthetic` / `shopify-dev`，不接真实客户数据 |
| 密钥 | 只放 VPS 的 `.env`，仓库只有 `.env.example` |

## 关键设计

- 签名：Shopify `X-Shopify-Hmac-Sha256`，对原始 body 做 HMAC-SHA256 再 base64，`timingSafeEqual` 比较；通用来源加时间戳窗口防重放。
- 幂等：`UNIQUE(source, event_id)` + `INSERT … ON CONFLICT DO NOTHING`，重复投递也返回 200。Shopify 的 `event_id` 取 `X-Shopify-Webhook-Id`（同一次投递的重试保持不变）；`X-Shopify-Event-Id` 只存入 `correlation_id`，不用于去重，因为同一商家操作触发多个订阅时它们共享该 ID，用它去重会丢事件。依据：Shopify 官方 "ignore duplicates" 文档（经搜索摘要核对，未逐字阅读原文）。
- 先落库再处理：验签、入库后立即 2xx，worker 异步处理。
- 重试：`attempts`、`next_attempt_at`、指数退避加抖动，超限转 `dead`。
- 看板 API：`GET /events`、`/events/:id`、`/stats`；限流；CORS 只允许 portfolio 的 Origin；重放按钮不放公网。
- Compose 布局（已定）：Caddy 和 Postgres 是 webhook-hub 与 DealWatch 共用的基础设施，VPS 上单独一个 `infra` compose，各项目 compose 只含自己的服务；`infra` 的配置放在本仓库的 `deploy/infra/` 下，等 DealWatch 加入时再决定是否拆出去。网络分两个：`edge`（Caddy 和各应用，Caddy 往应用转发）和 `db`（Postgres 和各应用，`internal`，无出站路由），Caddy 不在 `db` 上，面向互联网的容器够不到数据库（PR #5 的 review 指出原先的单一 `edge` 太平）。每个项目一个数据库和角色，并且要 `REVOKE CONNECT ON DATABASE ... FROM PUBLIC`：本地测试发现 PostgreSQL 默认允许任何角色连任何数据库，不撤销的话"每个项目独立数据库"在连接层并不成立。初始化脚本只在数据目录为空时运行一次，之后新增项目的库要手工创建，步骤和第一次初始化失败后的恢复办法写在 `deploy/README.md`。
- 代码到 VPS 的方式（已定）：在 VPS 上把本仓库克隆到 `/opt/webhook-hub`，`infra` 直接从 `deploy/infra/` 运行，真实 `.env` 放在同一目录（被 `.gitignore` 忽略，权限 600），不另存一份拷贝，所以 VPS 不会和仓库悄悄不一致；只跟 `main`，用 `git pull --ff-only` 更新。Caddyfile 是单文件挂载，改了之后要重建 Caddy 容器（这点是推断，未实测）。
- 应用 compose（已定，本地和 VPS 上都验证过，见下）：`deploy/webhook-hub/compose.yaml`，单个服务 `webhook-hub`（Caddyfile 转发的就是这个名字），加入外部网络 `edge` 和 `db`，不发布端口；镜像在 VPS 上用仓库的 `Dockerfile` 构建，不用镜像仓库，先求简单；`TRUST_PROXY=1`，数据库密码和 Shopify 密钥来自该目录下被忽略的 `.env`。`RATE_LIMIT_MAX` 在 `config.ts` 里默认 60，所以服务启动时限流是开着的；只有测试里直接调用 `buildApp` 且不传这个字段时才没有限流。compose 里显式写出它，只是为了让设置可见。镜像按提交打标签（`webhook-hub:<短 SHA>`，同时写入 revision 标签），上一个镜像留在本机，可以直接回滚；更新命令必须带 `SOURCE_REVISION`，不带时标签是 `unknown`。部署后用访问日志里的 `remoteAddress` 检查限流看到的是访客的真实地址，而不是 Caddy 的（README 的 First start 第 5 步）。本地用一次性的 `edge`/`db` 网络、临时 Postgres 和前置 Caddy 验证过：构建、健康检查、迁移、不发布端口，以及 63 个各带不同伪造 `X-Forwarded-For` 的请求仍然共用一个限流桶（60 次通过，之后 429）。这是本地 Caddy，不是生产的那个。2026-11-27 在 VPS 上验证：镜像在 arm64 上构建成功（约 27 秒），容器 healthy，迁移已应用，`/healthz`、`/events`、`/stats` 从外网访问均为 200 且证书有效，日志里的 `remoteAddress` 是访客的真实 IPv4 地址，所以 `TRUST_PROXY=1` 在生产 Caddy 之后生效；签名测试请求得到 accepted、duplicate、错误签名 401，worker 在 100 毫秒内处理完成。未验证：回滚和清理镜像的命令、IPv6 客户端（域名只有 A 记录，Docker 怎么传 IPv6 来源地址没测过）、重启后两个容器是否都自动恢复、256 MB 限制下的内存占用、真实的 Shopify 签名请求头。
- 可观察性：结构化日志、`/healthz`、简单 `/metrics`。
- 公网入口防护：`/webhooks/*` 限制 body 大小（如 1 MB）并限流，验签失败返回 401 且不落 payload。
- 网络暴露：只有 Caddy 监听 80/443；Postgres 和 Node 服务只在 Compose 内部网络，不映射宿主端口；SSH 保持仅密钥登录。
- 主机防火墙：OCI 的 Ubuntu 镜像用 `/etc/iptables/rules.v4`（netfilter-persistent），在已有 REJECT 规则之前插入 80/443 的 ACCEPT，不要另启 ufw 叠加。

## 已核实 / 未核实

- 已核实：OCI Cost Analysis 截至 2026-11-15 各项（Compute、Block Storage、Object Storage、VCN、Telemetry）均为 €0.00；账单数据约有 24 小时延迟。
- 已核实：`duckdns.org` 在 Public Suffix List 中，Let's Encrypt 限额按子域名独立计算；DuckDNS 官网当前可访问。`sslip.io` 不在该列表中，限额与其他用户共用，不作为首选。
- 已核实（2026-11-27）：在本 VPS 上起了 `infra`（Caddy + Postgres 17）。Caddy 先后从 Let's Encrypt staging 和正式环境为 `lab-2026.duckdns.org` 签发了证书（HTTP-01，日志里是多个地点的验证请求，说明 TCP 80 从公网可达）；从外网访问 `https://lab-2026.duckdns.org/` 证书校验通过，应用容器不存在时返回 502，`http://` 返回 308 跳转到 https；日志里出现过互联网扫描器经 HTTP/2 来的请求，说明 TCP 443 也可达。Postgres 初始化脚本只在首次启动运行一次，创建了 `webhook_hub` 角色和库并撤销了 PUBLIC 的 CONNECT，状态 `healthy`，没有发布端口。`deploy/README.md` 里克隆、staging 演练、启动和切换到正式环境的步骤在 VPS 上实际跑通；`.env` 一步实际是用 `openssl rand -hex 24` 生成的密码写入的，README 里写的 `-base64` 没在 VPS 上试过；切换时删掉 `.env` 里的 `ACME_CA` 再 `docker compose up -d`，只重建了 Caddy。
- 未核实：DuckDNS 长期稳定性（个人运营，无 SLA）；Shopify Partner / 开发商店当前条款（注册时以页面为准）；Shopify 真实投递的请求头是否与上述一致（目前只用本地签名请求测试过，要等开发商店或真实投递来验证）。
- 闲置回收：Always Free 的回收规则可能覆盖常驻的小服务，官方文档未确认 PAYG 是否豁免，不作保证。部署轻量服务本身不会让 CPU、网络、内存的第 95 百分位超过 20%，所以"尽快部署"不能当作防回收手段。缓解办法是整个环境写成 compose 加备份加 runbook，能在新实例上重建。

## 待定

- 查询层：目前骨架直接用 `pg` 加手写 SQL 迁移（`migrations/*.sql` 加极简迁移器）。是否引入 Drizzle（自带 drizzle-kit，招聘需求常见）或 Kysely，等写到只读 API 和 worker、查询变多时再定。
- 多个项目共用一个主机名时怎么分发：DuckDNS 的子域名只有一层，所以要么用路径前缀（`/webhook-hub/...`），要么每个项目各注册一个 DuckDNS 名字。现在只有 webhook-hub，放在根路径；等 DealWatch 加入时再定。（已定的 Compose 布局见"关键设计"。）

## Tooling 迁移（来自 badminton-club-app）

来源：`badminton-club-app` commit `0849b529`（2026-11-05），拷贝后在本仓库维护，不做同步。`agent-project-foundation-kit` 已弃用，不作为来源。

- 已迁移：`.repo-tools/scripts/` 下的 safety-guard（密钥扫描）及其依赖和测试、`.github/workflows/repository-safety.yml`、`biome.json`（去掉 Next/Tailwind 相关项）、`mise.toml`（Node 24、pnpm 11.26.0）、`.claude/settings.json`（最初照搬 badminton 的 deny `gh pr create/merge`，后改为：`gh pr create` 允许；`gh pr merge`、`git push`、`gh repo create` 每次询问；GitHub MCP 的 PR 创建和合并工具与自动合并开关仍禁止。2026-11-28：`AGENTS.md` Boundaries 去掉了「开 PR 前先问」，与这里的 `gh pr create` 允许对齐，并与 agent-home `core.md` 一致（push 和合并要批准，开 PR 不需要单独批准）；每个 PR 仍要 review，合并不静默。同日再放宽：推送 `feat/`、`fix/`、`chore/`、`docs/` 功能分支不再每次弹窗（allow），因为用户在对话里已经批准过 push，再弹一次是重复确认。allow 的通配符 `*` 能匹配空格和冒号，所以单靠几条 deny 拦不住 `feat/x:main`、`feat/x main`、`+` 开头的强推 refspec、`--mirror` 之类（PR #13 的 review 发现），因此补了一组 deny：任何带冒号、`+`、`refs/`、`--force`、`-f`、`-d`、`--delete`、`--mirror`、`--all`、`--tags`、`git -C … push` 的 push，以及分支名后面再跟任何参数、裸 `main`；不带参数的 `git push` 仍询问（可能推的是 `main`）。这是黑名单，只挡已知写法，没列到的写法会落到默认的弹窗，在自动接受或绕过权限的模式下就不会被拦住；匹配规则用本地脚本按「`*` 匹配任意字符、deny 高于 ask 高于 allow」的假设模拟过一组用例，没有对真实的权限引擎做过测试。注意：推送命令不要再带 `2>&1` 之类的重定向，会因「分支名后面还有参数」被 deny。原因：badminton 的 deny 配套有自己的发布脚本，这里没有，deny 只会挡住唯一的路径）、精简版 `AGENTS.md` / `CLAUDE.md`。
- 已验证：`pnpm check` 通过；`pnpm test` 27 项通过。
- 部分验证：仓库已于 2026-11-15 创建（`pengcc/webhook-hub`，公开，MIT）并推送 `main`。`pnpm safety:guard` 在 `main` 上扫描 0 个文件；在 `feat/service-skeleton` 上第一次真实扫描（22 个文件）就拦下了 README、`compose.yaml`、测试辅助文件里带密码的数据库 URL（`credential-bearing-url`，均为本地开发的一次性值，但扫描器不区分，且该规则不识别 URL 里的占位符）。处理方式：不放宽扫描器，改为 URL 不含凭据、密码走 `PGPASSWORD`（`pg` 会读取它），修改后扫描通过。两个 CI 工作流已在 PR #1 上于 GitHub 的 Ubuntu 运行并通过（`Baseline quality`、`Typecheck, test, build`，经 API 读回均为 success）。
- `Dockerfile` 已在骨架里写好（多阶段、pnpm 缓存挂载、仅生产依赖、非 root `node` 用户、HEALTHCHECK），见下一节验证结果。
- 不迁移：IONOS / nginx / Mongo 相关部署与备份脚本、dev-session 和 local-production 脚本、分支和 worktree 清理、Task State / Project Memory / goal-mode、Next.js 和 TanStack 专用 skills。部署和备份思路（部署前检查、回滚、备份验证）在 Oracle + Caddy + Postgres 上重写。

## 骨架实现状态（PR #1，2026-11-15 已 squash 合并为 `6522e32`）

- 已实现：`GET /healthz`；`POST /webhooks/shopify`（先验签，失败返回 401 且不落库；缺投递头或 JSON 非法返回 400；入库幂等；body 上限 1 MiB）；`migrations/001_events.sql`（`events` 表，状态 `pending/processing/done/failed/dead`，`attempts`，`next_attempt_at`，唯一约束 `(source, event_id)`）；zod 环境变量校验（错误只报变量名）；日志脱敏签名头。
- 已验证：`pnpm typecheck` 和 `pnpm check` 通过；`pnpm test:service` 15 项通过，针对真实 Postgres 17，包括 10 个并发相同投递只落 1 行；变异检查：把验签改成恒为真、去掉唯一约束，相应测试都会失败，恢复后全部通过。Docker 镜像构建成功（arm64，约 374 MB，非 root）；容器连本地 Postgres 做了冒烟测试：合法签名 200 accepted、重复 200 duplicate、错误签名 401，库中只有 1 行。
- 数据库凭据约定：`DATABASE_URL` 不含密码，密码放 `PGPASSWORD`（VPS 的 `.env` 同理，见 `.env.example`）。已验证：容器用不含密码的 URL 加 `PGPASSWORD` 能连库并入库。
- 本地测试偶发 `ECONNREFUSED`（Postgres 容器不在运行）：2026-11-16 复现并确认一个原因：`docker compose --profile app down` 会连同 `postgres` 服务一起删除，而不只是停 `app`。测试依赖该容器，所以冒烟测试之后紧接着跑测试会失败；`pnpm db:up` 后全部通过。2026-11-15 那次是否同一原因没有证据，只能说这是一个已确认存在的机制。以后冒烟测试收尾用 `docker compose --profile app stop app`，不要用 `down`。
- 未实现（骨架当时）：worker、重试和死信（已在下一节完成）、只读 API、CORS、限流（目前只限制了 body 大小）、`/metrics`、DuckDNS 和 Caddy、VPS 部署。
- 未验证：在 Oracle ARM 主机上运行（本机 Mac 也是 arm64，但不是同一环境）；Shopify 真实投递。
- `main` 分支保护（2026-11-15 设置，已读回确认）：必须走 PR；必需检查 `Baseline quality` 和 `Typecheck, test, build`；禁止强推和删除；不要求审批（所需审批数 0）；`enforce_admins` 为 false，管理员可绕过，所以对仓库所有者本人并不强制。

## Worker、重试与死信（分支 `feat/worker-retries`，2026-11-16）

- 机制：`src/worker.ts` 的 `runOnce` 用 `FOR UPDATE SKIP LOCKED` 领取到期事件（`pending`/`failed` 且 `next_attempt_at` 已到，或卡在 `processing` 超过锁超时）；领取时 `attempts` 加 1，崩溃的那次也计入；重新领取时若 `attempts` 已超过上限，直接置 `dead` 且不再运行处理器（PR #2 review 发现：原先只在处理器抛错后才判断上限，崩溃循环的事件永远进不了死信）；处理成功置 `done`，可重试的失败置 `failed` 并按退避排期，达到 `WORKER_MAX_ATTEMPTS`（默认 12，退避总窗口约 1.2–2.4 小时）或抛出 `PermanentError` 则置 `dead`。单个处理器有超时（`WORKER_HANDLER_TIMEOUT_SECONDS`，默认 60，必须小于锁超时），超时按可重试失败处理，但无法取消仍在运行的处理器；回写结果失败不会被当成处理器失败，事件保持 `processing`，锁超时后重新处理（至少一次投递，处理器应当幂等）。worker 使用独立的 3 连接小连接池，不与 HTTP 争用连接。
- 退避：`src/backoff.ts`，指数增长（基数 5 秒，上限 1 小时）加 "equal jitter"（落在 [exp/2, exp]），避免重试扎堆，也不会几乎立即重试。
- 围栏：成功、重试、死信三个更新都带 `AND attempts = $n`。如果慢的 worker 在锁过期、事件被别的 worker 重新领取之后才返回，它的更新不会生效，不会覆盖新结果。
- 处理器：`src/handlers.ts` 目前只校验订单 payload（`orders/create`、`orders/updated` 需要 `id`），不符合的抛 `PermanentError` 直接进死信；没有注册处理器的 topic 标记为 `done`（不是错误，但也意味着这类事件被静默视为已处理，日志里有 `no handler, done`）。**没有做订单的业务投影，处理逻辑是占位**。
- 运行方式：同进程后台循环，`WORKER_ENABLED`（默认 true）、`WORKER_POLL_MS`、`WORKER_BATCH_SIZE`、`WORKER_MAX_ATTEMPTS`、`WORKER_LOCK_TIMEOUT_SECONDS`、`WORKER_HANDLER_TIMEOUT_SECONDS` 可调；关闭时先停 worker 再关 HTTP 和连接池。迁移 `002_worker_lock.sql` 增加 `locked_at` 列和索引。
- 已验证：类型检查和 Biome 通过；服务测试 32 项（含 5 项退避、12 项 worker）针对真实 Postgres 通过；变异检查 7 项（去掉围栏、不在领取时加 attempts、最大次数差一、忽略 `next_attempt_at`、去掉行锁、不回收卡住的事件、`PermanentError` 当可重试）都会让相应测试失败，恢复后全部通过。其中去掉围栏和不加 attempts 两项导致的失败数偏多（11、10），原因包含失败后的连锁影响，并不都是各自独立的断言。容器端到端：迁移 `002` 在已有数据的库上应用成功，骨架阶段遗留的 2 个 `pending` 事件被处理为 `done`，合法订单为 `done`，缺 `id` 的 payload 进入 `dead` 且错误信息可读。
- 未验证 / 已知局限：只去掉 `SKIP LOCKED` 而保留 `FOR UPDATE` 时测试不会失败，因为在 READ COMMITTED 下行锁加条件复查仍能保证不重复处理，`SKIP LOCKED` 的价值在吞吐和等待，没有被测试覆盖；多进程部署下的行为和 worker 并发上限没有压测；没有给 worker 设置每个事件的处理超时（处理器挂起会占用到锁超时才被回收，回收后原处理器的结果会被围栏挡掉）；没有指标，死信目前只能查库或等只读 API。
- 重放死信：本轮没有做，需要的是写操作，放在管理端，不放公网（见"看板 API"）。

## CI 与流程取舍

- 迁来的 `repository-safety.yml` 只跑密钥扫描和 Biome，不跑类型检查、测试、构建，所以它的绿色对服务本身说明力很弱。已新增 `.github/workflows/ci.yml`：Postgres 17 服务容器，依次 `pnpm typecheck`、`pnpm test`（repo-tools 和服务两套）、`pnpm build`。收益是：在干净环境复现（`--frozen-lockfile`、全新数据库）、防止忘跑、让将来的必需检查有意义。局限：开发者本机已跑过同样的检查，CI 抓的是环境差异和遗漏，不是新类型的 bug。
- 暂不加 Docker 构建：GitHub 默认运行器是 x86，部署目标是 ARM，构建通过不能证明目标环境没问题；等有自动部署再加（公开仓库可用免费 ARM 运行器，标签和限额未核实）。
- 未迁移 badminton 的 Issue、Plan、Review、Merge 流程（`open-or-update-pr`、`merge-pr` 等）：对单人作品集过重。这是有意取舍，而不是遗漏。计划批准和 PR review 是否触发，由 `AGENTS.md` Project Profile 的 `workflow` 一行声明，这里不再重复。
- 引用 agent-home（2026-11-27，PR #8）：`AGENTS.md` 现在引用 `~/Projects/agent-home/core.md` 并带 Project Profile，选用 `plan`、`execute-plan`、`implementation-review` 三个 skill（最初是 `code-review`，agent-home 改名后更新）。采用的是 `core.md` 的边界、授权（push、合并、部署都要先问；开 PR 不需要单独批准，见 Tooling 迁移）和工作方式；它的 9 步交付流程里，计划批准和 PR review 是否触发由 Project Profile 的 `workflow` 一行声明，合并审批和授权清单不受其影响，上一条"对单人作品集过重"的取舍不变。没有采用 `open-or-update-pr`、`merge-pr`，也没有采用 agent-home 的 guard hook 和 settings 模板（本仓库自己的 `.claude/settings.json` 照旧，见上文 Tooling 迁移）。该路径只在本机存在，VPS、CI 和别人 clone 时指向空，这种情况下以 `AGENTS.md` 自身的规则为准。
- 密钥扫描：自带约 1670 行迁移来的代码；更通用的做法是 CI 里用 gitleaks。待定：保留还是替换。GitHub 自带的 Secret Scanning 和 push protection 已开启。

## 备选（未采用）

- 全 Cloudflare（Workers + D1 + Queues，`*.workers.dev`）：零成本零运维，但技术栈变成 Workers + SQLite，与 Node + Postgres 的外包场景不符，也不适合 DealWatch 这类常驻服务。
- 买域名：每年几欧，地址更稳定，之后可迁移。
- Cloudflare Tunnel：不开入站端口，但需要域名托管在 Cloudflare。

## 推进顺序

先打通端到端的最小骨架，尽早验证还没核实的部署链路（DuckDNS + Caddy 证书 + 防火墙），再往里加功能。

1. 最小骨架（本地）：Fastify 服务，`/healthz` 加 `POST /webhooks/shopify`（验签 + 幂等入库），一条迁移，一组测试；Compose 本地能跑。
2. VPS 基础设施：装 Docker；放行 80/443（OCI Security List + iptables）；注册 DuckDNS；起 `infra`（Caddy + Postgres）；确认证书签发成功、`https://<名字>.duckdns.org/healthz` 可访问。进度（2026-11-27）：OCI 安全列表已放行 TCP 80/443（控制台截图确认）；主机 iptables 在 REJECT 之前插入了 80/443 的 ACCEPT，并用 `netfilter-persistent save` 写入 `/etc/iptables/rules.v4`（读回文件确认，规则文件与装前生效的规则一致）；Docker Engine 29.10.1 和 Compose v5.8.1 已从官方 apt 源安装（arm64），`hello-world` 通过，装后 INPUT 链没变；DuckDNS 子域名 `lab-2026.duckdns.org` 已注册，`dig` 确认解析到 `152.70.17.121`（注意：DuckDNS 创建时会自动填入操作者当前的公网 IP，必须改成 VPS 的地址，否则会公开自己的出口 IP）；`infra` 的配置已写好（`deploy/infra/`，PR #5），并已在 VPS 上启动：证书签发成功，外网访问 80/443 正常（细节见"已核实 / 未核实"）。应用的 compose（`deploy/webhook-hub/`，PR #10）已在 VPS 上运行并验证（见"应用 compose"一条）。未完成、未验证：Caddyfile 改动后单文件挂载的表现、README 里"新增项目数据库"流程（含 `sudo --preserve-env`）。
3. 部署骨架：创建 GitHub 仓库并推送，在 VPS 上部署，用模拟发送器从外网打一次。进度（2026-11-27）：仓库已推送，应用已部署在 VPS 上。签名测试请求是在 VPS 上用 `openssl` 加 `curl` 发的（`--resolve` 指向本机的 Caddy，经过 TLS 和 Caddy，但不是真正从外网发出，密钥因此不必离开 VPS）；读 API 则是从外网访问过。步骤在 `deploy/README.md` 的"Test delivery"。仓库里还没有独立的模拟发送器脚本。
4. 功能补齐：worker、重试、死信（已完成，见上）；只读 API 已完成（`src/read-api.ts`：`GET /events` 按 id 倒序、游标分页、可按 `status`/`topic` 过滤；`GET /events/:id`；`GET /stats` 各状态计数）；CORS 和限流已完成（见下）；接下来：`/metrics`。API 响应不包含 `payload`，列表和详情只返回投递元数据和处理状态（这是为了公网接口不暴露订单内容，待确认）；也不返回 `last_error` 原文（可能含下游地址等内部信息），只给 `has_error` 布尔值。`/stats` 要全表计数，所以在内存里缓存 5 秒（并发请求共享一次查询，失败不缓存）；所有 5xx 统一返回 `{"error":"internal error"}` 并带 `Cache-Control: no-store`（Fastify 会保留抛错前已设置的头，不覆盖的话失败的 `/stats` 会带着 `public, max-age` 被代理缓存），错误详情只写日志。已知未处理：客户端 `max-age` 不扣除服务端缓存已用的时间，看板最多可能看到约两倍窗口（约 10 秒）前的数据；全局错误处理器也改变了 webhook 路由 4xx 响应体的形状（只剩 `error` 字段）。已知未做：读接口仍用读写连接池（原计划是只读角色）；按 `status`/`topic` 筛选没有专用索引。

- CORS 与限流（`@fastify/cors`、`@fastify/rate-limit`，在 `src/app.ts`）：`CORS_ALLOWED_ORIGINS`（逗号分隔，必须是不带路径的 origin，写错会在启动时报错且只报变量名）只允许 portfolio 的域名，只放行 `GET/HEAD/OPTIONS`；没配置时完全不发 CORS 头。限流只作用于读 API，按客户端 IP，默认每 60 秒 60 次（`RATE_LIMIT_MAX`、`RATE_LIMIT_WINDOW_SECONDS`），超限返回 429 加 `Retry-After`；`/healthz` 不限。**webhook 路由没有限流**（偏离了上面"公网入口防护"里的设想）：平台的投递来自共享地址，限流可能误伤合法投递，它靠验签和 1 MiB 的 body 上限保护；未签名的请求仍要付出一次 HMAC 计算的代价，如果以后需要，放在 Caddy 一层限。`TRUST_PROXY` 默认 `false`；部署在 Caddy 之后设为跳数 `1`（也可填代理地址或 CIDR 列表），这样取的是最近一个受信代理看到的客户端地址，客户端自己写在 `X-Forwarded-For` 最左边的值会被忽略（review 发现：布尔 `true` 信任所有跳并取最左边的值，代理若是追加而不是覆盖，客户端可以每次伪造新地址绕过限流，所以不推荐 `true`）。设错的后果：不信任时所有客户端共用 Caddy 的地址、共享一个桶；跳数多填时仍可能取到伪造值；所以 `app` 端口也不能直接暴露。因为部署一定在 Caddy 之后而默认值是 `false`，忘了设置会让所有访问者共用一个桶、看板自己也被 429（review 发现）：限流开启且 `TRUST_PROXY` 为 `false` 时，第一次收到带 `X-Forwarded-For` 的请求会记一条警告（只记一次）。写部署 compose 时要直接设 `TRUST_PROXY=1`。限流计数在进程内存里，重启清零，只适合单实例。已验证：测试覆盖 CORS 允许和拒绝、预检、429 仍带 CORS 头、webhook 和健康检查不受限、不信任代理 / 信任所有跳 / 跳数三种代理模式（含伪造最左边地址）、`TRUST_PROXY` 配置解析与校验、未设置 `TRUST_PROXY` 时的一次性警告；去掉限流、总是信任所有跳、反射任意 origin、去掉 `exposedHeaders`、去掉 `TRUST_PROXY` 校验、警告每次都记 / 条件不对 / 从不记，这些变异都被测试发现。未验证：没有在 Caddy 之后实际测过 `X-Forwarded-For` 的行为。
5. portfolio 加看板和降级快照。
6. 运维：`pg_dump` 每日备份到 Object Storage，做一次恢复演练；日志轮转，镜像定期 prune；容器内存限制（Postgres 约 512 MB，Node 约 256 MB，Caddy 约 64 MB）。
7. 可选：接 Shopify 开发商店，在 README 放截图或录屏。

## 对外动作（每次先征求同意）

创建 GitHub 仓库、推送、部署、注册 DuckDNS / Shopify Partner 等账号。Oracle 控制台由用户自己操作，Claude 只给出选项。

## 待办

- ~~1 到 2 天后再看一次 OCI Cost Analysis~~：2026-11-15 已确认 €0。部署后（尤其开始用 Object Storage 备份后）再看一次。
- 容量与风险：这台机器约放 5 到 10 个小服务；系统盘小，只有一个公网 IP，单机无冗余。README 里直接写明。
