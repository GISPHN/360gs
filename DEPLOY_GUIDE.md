# 360GSをGitHub Pagesで公開する手順

初回だけ必要です。公開後の日常利用ではGitHubを操作する必要はありません。

## 公開設定

1. GitHubで `GISPHN/360gs` を開く
2. `Settings` を開く
3. 左側の `Pages` を開く
4. `Build and deployment` の `Source` で `Deploy from a branch` を選ぶ
5. Branchを `main`、フォルダを `/(root)` にする
6. `Save` を押す

現在はこの設定が完了しています。mainブランチへ変更が入るとGitHub Pagesが自動で更新されます。

## Version 0.1b の使い方

### 360°写真を見る

1. 公開URLを開く
2. 「360°写真を見る」を押す
3. 写真を選ぶ
4. 画面をドラッグして見回す

### 3DGSを見る

1. 公開URLを開く
2. 「3DGSファイルを見る」を押す
3. `.ply`、`.compressed.ply`、`.sog` のいずれかを選ぶ
4. ドラッグで回転、ホイールで拡大縮小する

3DGSファイルを持っていない場合は「サンプル3Dで試す」で動作確認できます。

Version 0.1bでは、自分で選んだ360°写真と3DGSファイルはブラウザ内だけで扱われ、サーバーには保存されません。

## 次の開発段階

- Cloudflare R2への保存
- 限定共有
- 360°動画から3DGSを自動生成する処理
