# AI Chat Exporter

一个用于 Edge / Chromium 的 Manifest V3 扩展，将当前 ChatGPT、Gemini 或 DeepSeek 对话保存为 Markdown 文件。

## 安装

1. 解压项目到本地文件夹。
2. 打开 `edge://extensions/`，开启「开发人员模式」。
3. 点击「加载解压缩的扩展」，选择包含 `manifest.json` 的目录。
4. 刷新已打开的对话页面。

## 操作

页面工具栏的导出按钮直接保存当前对话。右侧箭头用于设置导出档位。拖动滑块时连续跟手，松开后吸附最近档位；点击轨道或使用方向键、`Home`、`End` 也可选择档位。设置自动保存，对话不会在切换档位时导出。导出过程中如果切换了对话页面，会取消本次保存，避免将内容与错误的页面对应。

| 档位 | 输出内容 |
| --- | --- |
| 极简 | 对话正文、角色顺序、附件名称 |
| 完整 | 正文、`<think>` 思考、工具交互、附件信息、时间戳 |
| 详尽 | 完整档内容、消息 ID/父级、分支标识、附件来源、文本附件正文、二进制资源的 Base64 附录 |

导出的结构标签统一使用英文：`Source`、`Model`、`User`、`ChatGPT`、`Answer`、`Tool call`、`Attachments`、`Resource appendix`。扩展界面本身仍是中文。

每次导出产生一个 `.md` 文件；同一对话更新时覆盖其受控文件，不产生连续编号的副本。资源按哈希去重，同一附件只列一次。详尽档通过平台文件接口读取附件：文本附件内联正文，二进制附件写入 Base64；无法读取时保留引用和原因。

## 代码结构

```text
manifest.json               扩展声明与最小权限
background.js               下载事务、媒体资源代理、工具栏消息
content/
  core.js                   档位、标准消息模型、资源与公共工具
  markdown.js               Markdown 渲染与导出摘要
  exporter.js               导出编排和扩展消息通信
  ui.js                     浮层交互、键盘/指针事件与生命周期
  ui.css                    Shadow DOM 样式
  button.js                 站点工具栏锚点和按钮位置
  main.js                   站点分发
  adapters/
    chatgpt.js              ChatGPT 对话接口与结构解析
    gemini.js               Gemini RPC 分页与候选解析
    deepseek.js             DeepSeek 对话接口与结构解析
icons/                      页面及扩展图标
tests/                      数据、后台和交互测试
```

## 设计与维护

- **站点适配器**：只负责调用对应平台接口并将对话转换为统一消息结构；各平台协议变化应局部处理。
- **公共内核**：`core.js` 管理档位、数据规范化和资源；`markdown.js` 只负责序列化；`exporter.js` 负责读取、组装与下载事务。
- **页面控件**：`ui.js` 处理交互和状态，`ui.css` 负责 Shadow DOM 样式，`button.js` 负责工具栏定位；不直接解析平台消息。
- **后台任务**：`background.js` 负责下载、记录管理和白名单媒体读取；首次导出自动规避同名文件，后续直接覆盖已经确认属于同一对话的文件；下载成功后更新文件记录，记录写入失败时提示。

不引入额外运行依赖或构建步骤。导出档位固定为 `minimal`、`full`、`detailed`；滑块拖动连续跟手，松手时按最近节点提交。任何改动都应保持三平台的数据解析测试、下载异常测试和交互测试通过。

## 附件下载

详尽档会尝试把附件正文写进 Markdown；极简和完整档只列名称、类型和链接，不下载。

### ChatGPT

附件引用形如 `file-service://file_...`。下载顺序：

1. 消息元数据里直接带 `download_url` / `url` 时，优先用它
2. `/backend-api/files/download/{id}?conversation_id={当前对话ID}&inline=false`
3. `/backend-api/conversation/{对话ID}/attachment/{id}/download`
4. `/backend-api/files/download/{id}`
5. `/backend-api/files/{id}/download`

`{id}` 会同时尝试 `file_...` 和 `library_file_id`（`libfile_...`）。项目对话里的附件必须带 `conversation_id`，否则常见结果是 403。

### Gemini

用户上传的文件在提问侧的附件区，和助手回答里的图片是两套数据。下载地址通常是 `contribution.usercontent.google.com/download?...`，需要：

- `host_permissions` 包含 `https://*.usercontent.google.com/*`
- 后台白名单包含 `usercontent.google.com`
- 请求带 `Referer: https://gemini.google.com/`
- 跟随重定向，并校验最终域名

同一文件在后续回合会自动作为上下文重复出现；导出只在实际发生上传的那条消息下列出一次。

### 常见错误

| 错误 | 含义 |
| --- | --- |
| `不允许读取该域名` | `manifest.json` 的 host 权限或 `background.js` 的 `MEDIA_HOSTS` 没放开 |
| `HTTP 403` | 接口路径不对、缺少 `conversation_id`、登录态失效，或文件不属于当前账号 |
| `HTTP 404` | 对话或附件已删除、下载地址过期 |
| `资源内容为空` | 平台返回了空响应 |
| `Could not fetch the original file: ...` | 下载失败；附件行保留链接和原因 |

文本类附件（`.md`、`.txt`、`.json` 等）下载后直接内联正文；图片、PDF 等二进制写入 Base64 资源附录。

## 测试

要求 Node.js 22 或更高版本；无需安装第三方依赖。

```bash
npm test
```

`tests/ui-harness.html` 可在本地浏览器打开，对滑块定位、端点、弹层边界和深浅色进行手动验收。正式部署还应分别检查三个站点的真实登录对话、长对话和附件场景。

## 文件更新规则

- 首次导出使用 `uniquify`，不会覆盖无关的同名文件，并保存浏览器最终分配的文件名。
- 随后导出同一对话时，如果原文件仍可通过下载记录确认，则使用 `overwrite` 更新**同一文件**。对话标题变化不会修改已分配的文件名。
- 如果下载记录丢失、文件被移动或删除，不能确认文件归属，则回到首次导出策略以避免误覆盖。
- 更新是重新生成当前对话的**完整快照**，并非向原文件末尾追加字符串。用户直接修改导出的 Markdown，下一次自动更新会覆盖这些改动；需要保留的笔记请另存。

## 数据与权限

- 对话请求只发送到各平台自身的接口，使用当前页面登录状态。
- 不存在用户账号收集、远程分析或第三方上传服务。
- 使用 `storage` 记住档位和下载记录，使用 `downloads` 保存文件；首次保存时通过浏览器规避同名冲突；受控文件后续使用覆盖更新。
- `*.oaiusercontent.com`、`*.googleusercontent.com` 与 `*.usercontent.google.com` 权限仅用于读取平台附件。
- 资源读取仅允许指定的 HTTPS 域名；重定向会跟随，并对最终域名再次校验。

## 边界条件

- 平台内部接口不属于公开稳定 API；字段与鉴权方式可能变化。
- 未对外公开的模型内部推理无法导出。
- ChatGPT 仅导出当前活跃分支；Gemini 取活跃候选回复。
- Gemini 只列出实际发生上传的附件，自动携带的上下文文件不重复出现。
- 详尽档输出可读元数据（ID、父级、分支、附件来源）。
- 详尽档会把可读取的文本附件（`.md`、`.txt`、`.json` 等）直接内联到上传位置；二进制文件写入 Base64 资源附录。
- 部分沙箱文件或到期资源无法下载，详尽档只保留可取得的数据。
- 长对话和 Base64 资源会增加 Markdown 体积，浏览器可能拒绝超大的下载 URL。
