# Contributing

The extension is open source under the [MIT License](LICENSE.md), and contributions to it are under the same license. Hronaut itself, the app it connects to, is not: it stays under its Subscription and Trial License in [hronaut/hronaut](https://github.com/hronaut/hronaut), so don't copy its code here.

The extension is plain JavaScript with no dependencies at run time. `extension.js` registers Hronaut's MCP server with the editor, and `connection.js` finds Hronaut's port and owner token the way the app itself does. `README.md` is the store page, so keep it for people installing the extension.

## Test

The tests also check the extension against the Hronaut app: its MCP port, profile folder and prices. They read a checkout of [hronaut/hronaut](https://github.com/hronaut/hronaut) next to this one (`../hronaut`), or the folder `HRONAUT_APP_DIR` names.

```sh
npm ci
npm test
```

CI runs them on every push and pull request, and every Monday against the app's main branch, so a change in the app that the extension must follow fails here.

## Release

The extension has its own version, separate from the app's.

1. In a pull request, raise `version` in `package.json` and add a section for it to `CHANGELOG.md`.
2. After it merges, run the **Publish** workflow from `main`. It tests and packages the extension, publishes the .vsix to the VS Code Marketplace and Open VSX, then tags the commit `v<version>` and attaches the .vsix to a GitHub release.

Both stores trust the workflow, so it needs no tokens: the Marketplace through the `hronaut` publisher's trusted publishing policy, Open VSX through the trusted publisher of the `hronaut` namespace (in Open VSX user settings, Trusted Publishers). Both name repository `hronaut/hronaut-vscode`, workflow `publish.yml` and environment `extension-stores`, which only `main` can use.
