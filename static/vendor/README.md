LiveKit client SDK 2.23.0, Apache-2.0; see `livekit-client.LICENSE`.

The unmodified UMD bundle is vendored so server broadcasting works without a
third-party CDN. Source: https://github.com/livekit/client-sdk-js/tree/v2.23.0
Package: https://registry.npmjs.org/livekit-client/-/livekit-client-2.23.0.tgz

The npm archive SHA-512 (base64) is:
`j9Kg86nJjBjNFUD+ukp2jwMCGa0k+YD5gU//RzAM+ZY3pbG631QCte7fQjwqWMmtBzhDJL9nKYuOLMv/9IbAxg==`

To update, verify the npm archive integrity, copy `dist/livekit-client.umd.js`
and `LICENSE`, update the versioned filename in `static/broadcast.js`, and run
the broadcast browser tests against the deployed LiveKit server version.
