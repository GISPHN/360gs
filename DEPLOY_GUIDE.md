# 360GSをGitHub Pagesで公開する手順

初回だけ必要です。公開後の日常利用ではGitHubを操作する必要はありません。

## 公開設定

1. GitHubで `GISPHN/360gs` を開く
2. `Settings` を開く
3. 左側の `Pages` を開く
4. `Build and deployment` の `Source` で `Deploy from a branch` を選ぶ
5. Branchを `main`、フォルダを `/(root)` にする
6. `Save` を押す

公開処理が完了すると、Pages画面に公開URLが表示されます。

## 公開後の使い方

1. 公開URLを開く
2. 「360°写真を見る」を押す
3. 「写真を選ぶ」を押す
4. Insta360 Studioなどから書き出した360°写真を選ぶ
5. 画面をドラッグして見回す

Version 0.1aでは、選んだ写真はブラウザ内だけで扱われ、サーバーには保存されません。

## 次の開発段階

- 3DGSファイルのブラウザ表示
- Cloudflare R2への保存
- 限定共有
- 360°動画から3DGSを自動生成する処理
