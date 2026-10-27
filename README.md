# Deplite Files Action

Deplite 스토리지에 파일을 업로드·다운로드·삭제하는 GitHub Actions입니다.

```yaml
steps:
  - uses: Deplite/files-action@v0
    id: upload
    with:
      api-token: ${{ secrets.DEPLITE_API_TOKEN }}
      mode: upload
      path: ./build/app.apk
      cleanup-rule: ttl
      ttl-seconds: 3600

  - uses: Deplite/run-action@v0
    with:
      api-token: ${{ secrets.DEPLITE_API_TOKEN }}
      agent: mobile
      workflow: publish-release
      params: '{"fileId":"${{ steps.upload.outputs.file-id }}"}'
```

더 자세한 내용은 [Deplite 문서](https://docs.deplite.io)를 참고해주세요.

## 라이선스

[Apache-2.0](LICENSE) 라이선스로 제공됩니다.
