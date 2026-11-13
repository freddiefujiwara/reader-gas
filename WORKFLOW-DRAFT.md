# WORKFLOW-DRAFT — .github/workflows/ 追加用ドラフト

> このファイルはドラフトであり、CI では実行されない。
> GitHub MCP は `.github/workflows/` 配下を push できないため、内容をブラウザで
> `.github/workflows/node.js.yml` として追加すること。
> 既存の -gas リポジトリ (xuexi-gas 等) の実物ワークフローと突き合わせ、
> clasp のデプロイ手順が実物と異なる場合は実物に合わせてから追加する。
>
> 注意 (過去の事故からの決まり):
> - job レベルの `if` で secrets コンテキストを参照しない (ワークフロー全体が無効になる)。分岐はブランチ判定のみ。
> - デプロイIDは Secrets で固定する。未設定だと毎回新規デプロイが作られ、旧 /exec が 404 になる。

```yaml
name: Node CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test

  deploy-staging:
    if: github.ref != 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Write clasp credentials
        run: echo '${{ secrets.CLASPRC_JSON }}' > ~/.clasprc.json
      - name: Point clasp at the staging project
        run: |
          node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.clasp.json','utf8'));j.scriptId='${{ secrets.STAGING_SCRIPT_ID }}';fs.writeFileSync('.clasp.json',JSON.stringify(j));"
      - run: npm run build
      - name: Push and deploy (staging)
        run: |
          npm install -g @google/clasp
          clasp push --force
          clasp deploy --deploymentId '${{ secrets.STAGING_DEPLOYMENT_ID }}'

  deploy-prod:
    if: github.ref == 'refs/heads/main'
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Write clasp credentials
        run: echo '${{ secrets.CLASPRC_JSON }}' > ~/.clasprc.json
      - name: Point clasp at the production project
        run: |
          node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.clasp.json','utf8'));j.scriptId='${{ secrets.SCRIPT_ID }}';fs.writeFileSync('.clasp.json',JSON.stringify(j));"
      - run: npm run build
      - name: Push and deploy (production)
        run: |
          npm install -g @google/clasp
          clasp push --force
          clasp deploy --deploymentId '${{ secrets.DEPLOYMENT_ID }}'
```
