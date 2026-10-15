# lovense-mcp

[English](README.md) · **中文**

作者:Rosalie

## 项目简介

**在手机上的 Claude app 里,用自然语言控制 Lovense 玩具。** 部署一次之后,电脑可以关掉。

这是一个跑在 Cloudflare Workers 上的 MCP 服务器,通过 Lovense 官方云端接口(Standard API)转发指令。在 **Lovense Vulse** 上实测通过。

三个特点:

- **手机直控,不用电脑常开**:Worker 是无状态的,24 小时在线,免费额度够用。
- **MCP 2026-07-28 新规范**:无状态 Streamable HTTP;同时兼容旧版客户端(2025-11-25 / 2025-06-18 / 2025-03-26),新旧 Claude 都能连。
- **访问密钥保护,默认拒绝(fail-closed)**:密钥放在 URL 路径里,不用配 OAuth;没有配置密钥时 Worker 拒绝一切请求。

其他 Lovense 玩具走同一套接口,理论上可用,但只在 Vulse 上实测过。

> 仅限成年人。只用于你自己的设备。

## 工作原理

指令从 Claude 出发,经 Worker 和 Lovense 云端,最后由手机上的 Lovense Remote 通过蓝牙发给玩具。

```text
Claude app(手机 / 网页)
   │  MCP · Streamable HTTP · URL 自带密钥
   ▼
Cloudflare Worker(本项目)
   │  HTTPS · Lovense Standard API
   ▼
Lovense 云端
   │  推送到已配对的手机
   ▼
Lovense Remote app(手机)
   │  蓝牙
   ▼
玩具
```

Worker 每次调用只做三件事:校验 URL 里的密钥、把工具参数翻译成 Lovense API 格式、转发。配对关系存在 Lovense 服务器上,Worker 不保存任何状态。

Lovense 的指令自带时长参数,发一次就按时长运行,不需要客户端反复重发。所以一次对话里的调用次数很少,上下文开销可以忽略。

## 工具列表

连接器挂上后,Claude 能看到 6 个工具。日常只需要说人话,Claude 会自己选。

| 工具 | 作用 | 主要参数 |
| --- | --- | --- |
| `lovense_pair_qr` | 生成配对二维码,用 Lovense Remote 扫 | 无 |
| `lovense_vibrate` | 设置震动强度 | 强度 0–20、持续秒数 |
| `lovense_thrust` | 设置推力速度(推力类玩具) | 强度 0–20、持续秒数 |
| `lovense_pattern` | 播放内置波形预设 | 预设名、持续秒数 |
| `lovense_custom_pattern` | 播放自定义强度序列 | 强度序列、间隔 |
| `lovense_stop` | 立即停止所有动作 | 无 |

波形默认走震动通道;推力类玩具可以指定 `function: "thrusting"`。预设名和参数细节以 `src/tools.js` 里的定义为准。

## 实测设备:Lovense Vulse

**Vulse 只响应 `lovense_vibrate`,对 `lovense_thrust` 没有反应。**

Vulse 官方宣传是"推力 + 震动"的蛋(最高 120 次/分,推进 10 mm),很容易以为该用推力指令。但实际上:

- Lovense Remote 里它只有一个 Vibration 滑条。
- Lovense 接口只暴露 Vibrate 通道,推进和震动由同一个电机驱动,不能单独控制推力。
- 发 Thrusting 指令,API 返回成功,玩具不动。

所以给 Vulse 下指令时直接说"震动"。写预设波形也走 Vibrate 通道。

推力类玩具(如 Solace)理论上应该响应 `lovense_thrust`,但本项目没有实测过。Depth(深度,0–3)在 Lovense API 里存在,本项目没有实现。

## 准备工作

全部免费,只有电脑是部署时用一次。

| 需要 | 说明 |
| --- | --- |
| Lovense 开发者账号 | 在 [developer.lovense.com](https://developer.lovense.com) 注册,拿 Developer Token |
| Cloudflare 账号 | 免费套餐够用,Worker 跑在这里 |
| 一台电脑(一次性) | Windows / Mac / Linux,装 Node.js 20+;部署完就不需要了 |
| Claude 账号 | 能添加自定义连接器的套餐 |
| 手机上的 Lovense Remote | 玩具通过它连蓝牙,使用时保持在线 |
| 一个 Lovense 玩具 | 本项目在 Vulse 上实测 |

国内网络环境下,注册 Lovense 开发者、访问 GitHub 和 Cloudflare 部署都建议全程开代理。

## 部署

电脑上装了 Claude Code 的话,可以直接把仓库地址丢给它:"帮我部署这个仓库到我的 Cloudflare,缺什么环境你自己装。" 除了在浏览器里授权 Cloudflare、粘贴 token,其他命令它都能帮你跑。

1. 克隆仓库并安装依赖:

   ```bash
   git clone https://github.com/rosaliev24/lovense-mcp.git
   cd lovense-mcp
   npm install
   ```

2. 登录 Cloudflare(会打开浏览器让你授权):

   ```bash
   npx wrangler login
   ```

3. 生成一串访问密钥,存好:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

4. 写入 Lovense token 和访问密钥。提示后粘贴,回车;粘贴时屏幕什么都不显示,是正常的:

   ```bash
   npx wrangler secret put LOVENSE_TOKEN
   npx wrangler secret put MCP_ACCESS_KEY
   ```

   不要用 `echo "xxx" | wrangler secret put` 这种管道写法,一定用交互式粘贴(见踩坑记录)。

5. 部署:

   ```bash
   npx wrangler deploy
   ```

   输出里会有 Worker 地址,形如 `https://lovense-mcp.<子域>.workers.dev`。

6. 验证(只跑协议层,不会给玩具发指令):

   ```bash
   node scripts/check.mjs https://lovense-mcp.<子域>.workers.dev <密钥>
   ```

7. 填 Lovense 回调地址(**必须**):打开 lovense.com/user/developer/info,"回调网址"填

   ```text
   https://lovense-mcp.<子域>.workers.dev/lovense/callback
   ```

   不填的话生成二维码会直接被 Lovense 拒绝,token 再对也没用。

## 接入 Claude

### 添加自定义连接器

连接器 URL 是 Worker 地址 + `/mcp/` + 密钥:

```text
https://lovense-mcp.<子域>.workers.dev/mcp/<密钥>
```

1. 用浏览器打开 [claude.ai](https://claude.ai) 登录 → 设置 → 连接器 → **添加自定义连接器**。
2. 名字随意(如 Lovense),远程 MCP 服务器 URL 粘上面那条,OAuth 两项留空,点添加。
3. 添加成功后,连接器详情里会列出 6 个工具。权限默认"需要批准",熟悉后可以改成自动允许。

iOS 的 Claude app 目前没有"添加自定义连接器"入口。网页版加好后,手机 app 杀掉重开就能看到。

### 扫码配对(一次性)

1. 手机打开 Lovense Remote,蓝牙连上玩具。
2. 在 Claude 里新开对话,说"生成配对二维码"。第一次调用会弹权限确认,点允许。
3. 回到 Lovense Remote 扫这张码。二维码几分钟就过期,过期了重新生成一张。

配对信息存在 Lovense 服务器,之后不用再扫。

## 日常使用

每次使用只需两步:打开 Lovense Remote 并连上玩具,然后在 Claude 对话里说话。

示例:

- "震动强度 8,跑 30 秒"
- "播放一个预设波形"
- "渐强,从 3 到 15,每级 5 秒"
- "停"

Claude 会自己选工具并填参数。第一次建议从低强度(3 左右)跑几秒开始。

注意事项:

- Lovense Remote 要保持在线,玩具与手机的蓝牙不能断。app 被杀后台,指令会显示成功但玩具不动。
- Vulse 用"震动",不要说"推力"(见实测设备)。
- 每次调用约 100–200 token,工具定义一次性约一两千。连玩一小时也只占上下文的零头。

## 安全说明

**完整的连接器 URL 就是凭据。** 拿到它的人就能控制你的玩具。不要截图外发,不要贴进群聊。

- **默认拒绝**:Worker 没有配置 `MCP_ACCESS_KEY` 时,对所有请求返回 401,不会出现"裸奔"窗口。密钥错误同样 401。
- **密钥比对容忍首尾空白**:避免复制粘贴时多出的换行导致永远对不上。
- **Token 不进代码**:Lovense token 和访问密钥都存在 Cloudflare secret 里,不写进代码,不进 git。本地生成的 `.access-key.txt` 已在 `.gitignore` 中。
- **Worker 不保存数据**:不记录指令,不存配对信息。

### 轮换密钥

怀疑泄露,或者 URL 曾出现在聊天记录里,就换一个:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put MCP_ACCESS_KEY    # 粘贴新密钥
```

然后去 claude.ai 连接器设置里把 URL 换成新的。旧 URL 立即失效,不用重新部署,也不用重新配对。

## 踩坑记录

下面全是实际遇到过的问题,按部署顺序排列。

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 开发者申请表提交报"账号不存在或密码错误" | 申请表同时也是登录表,密码栏要的是已有 Lovense 账号的密码 | 先在 lovense.com 注册登录,再填申请表 |
| 开发者后台出现了两个令牌 | 误点了"添加新令牌" | 认准第一个用,多余的删掉 |
| 部署成功但网址打不开 | 账号还没注册 workers.dev 子域名 | Cloudflare 控制台 → Workers & Pages 注册一个 |
| 写入 secret 后验证一直 401 | 用了 `echo "xxx" \| wrangler secret put`,PowerShell 在末尾追加了换行 | 改用交互式 `wrangler secret put`,提示后粘贴 |
| 刚写入 secret,验证仍 401 | secret 传播有延迟 | 等 10–20 秒再测 |
| 生成二维码报 "Please set your Callback URL in your developer dashboard" | Lovense 要求必须配置回调地址,token 正确也会拒绝 | 后台 Callback URL 填 `/lovense/callback` 完整地址 |
| 回调地址填了显示"请填写网址",点 Save 存不上 | 手机竖屏下表单布局折叠,另一个区块的校验错误挡住了整个表单提交 | 手机横屏再 Save,或用电脑浏览器填 |
| 回调端点 GET 返回 405 | Cloudflare 边缘缓存了旧响应 | 当前版本 GET/HEAD/POST 都返回 200;遇到就加个随机参数重试 |
| iOS Claude app 找不到"添加自定义连接器" | app 里没有这个入口 | 用 claude.ai 网页版添加,app 自动同步 |
| 扫码提示失败 | 二维码几分钟就过期 | 重新生成,立刻扫 |
| 指令返回成功,玩具不动 | Lovense Remote 被杀后台或蓝牙断了;或者用了玩具不支持的通道 | 保持 Remote 在线;Vulse 用震动指令 |

## 已知限制

- 只在 Lovense Vulse 上实测。其他型号的指令响应未验证。
- 没有实现 Depth(深度)指令。
- 没有实现 Lovense 本地局域网模式,只走云端。
- 没有 OAuth,靠 URL 里的密钥鉴权。够个人用,不适合多人共享。

## 开发

```bash
npm test                    # 单元测试,全部 mock,不会碰真实设备
npx wrangler dev            # 本地起服务,读 .dev.vars(参考 .dev.vars.example)
node scripts/check.mjs      # 对本地实例跑协议校验
npx wrangler tail           # 看线上日志
```

```text
src/
  index.js      Worker 入口:HTTP 传输、鉴权、Origin 校验、路由
  mcp.js        协议层:版本协商、头部校验、方法分发
  tools.js      工具定义与处理
  lovense.js    Lovense Standard API 客户端
  patterns.js   波形预设
scripts/
  check.mjs     对运行中的实例做协议探测
test/
  protocol.test.mjs
```

## 致谢

- [amarisaster/Lovense-Cloud-MCP](https://github.com/amarisaster/Lovense-Cloud-MCP):Cloudflare Worker 方案的最初参考。
- [Lovense Standard API 文档](https://developer.lovense.com/docs/standard-solutions/standard-api.html)
- [MCP 2026-07-28 规范](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 本项目的代码由 Claude Code 生成。方案、实机测试和踩坑由 Rosalie 完成。

## 许可

MIT © Rosalie,见 [LICENSE](LICENSE)。
