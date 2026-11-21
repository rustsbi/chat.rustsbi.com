# RustSBI Agent

面向 RISC-V 固件开发者的网页问答工具。使用自己的 OpenAI 兼容 API，浏览器会检索 RustSBI Agent 的资料，并给出来源链接。API 密钥加密保存在 Cookie 中，对话历史加密保存在浏览器的 IndexedDB 中。可以从侧栏导出或导入对话备份。备份文件包含明文对话正文，不包含 API 密钥。

## 本地运行

从仓库根目录运行下面的命令。知识库索引在构建时生成，部署工作流使用同一个上游版本。

~~~sh
git clone https://github.com/rustsbi/Agent.git ../rustsbi-agent-docs
git -C ../rustsbi-agent-docs checkout --detach 7211dba8c60e9bd704b2fd0d6c6e56defae87de2
python3 -m venv .venv
.venv/bin/python -m pip install pypdfium2==5.15.2
.venv/bin/python scripts/index-agent.py ../rustsbi-agent-docs
.venv/bin/python -m http.server 41738 --bind 127.0.0.1 --directory dist
~~~

打开 [http://localhost:41738/](http://localhost:41738/)。填写 Base URL 和 API Key，刷新模型列表，选中模型后保存。API 服务需要支持浏览器跨域请求。

## 部署

推送到 main 后，GitHub Actions 会生成知识库索引并将 dist 发布到 GitHub Pages。仓库的 Pages 发布来源为 GitHub Actions。

自定义域名 chat.rustsbi.com 的 DNS 使用 CNAME 记录，主机记录为 chat，目标为 rustsbi.github.io。
