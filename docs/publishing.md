# Publishing

Nervelet is an ES module package for Node 24+, with compiled JavaScript, TypeScript declarations, a CLI and optional integration peers. The package name is `nervelet`; the initial npm release is `0.2.0`. The repository uses the [MIT license](../LICENSE).

## Prepare and verify

From the release checkout:

```sh
npm ci
npm run check:release
git diff --check
```

The release check runs the deterministic test suite, source/example type checking, documentation checks and an isolated package installation. It does not invoke inference or hardware. The package check verifies public imports, the README embedding example, the CLI and consumer TypeScript declarations. Core-only installation must leave optional SDK/MCP/serial packages absent.

`npm run check:package` builds and writes `.runtime/nervelet-0.2.0.tgz` plus `.runtime/package-check.json` with the archive integrity and installation evidence. Inspect the archive file list before publishing; credentials, runtime state and generated evidence must remain outside the archive and Git. For later releases, update the version in `package.json` and `package-lock.json` and use that version's archive name below. Never reuse a published version.

## Publish the checked archive

Sign in using your own npm account:

```sh
npm login
npm whoami
npm publish ./.runtime/nervelet-0.2.0.tgz --access public --registry https://registry.npmjs.org/
```

Complete npm's account verification if requested. Do not put credentials in the repository. Publishing the checked archive sends the exact bytes tested above; publishing the directory with `npm publish` runs `prepublishOnly`, which invokes the release checks first. Archive publication does not run that directory hook, so the prior release check is required.

Verify the live registry after publication:

```sh
npm view nervelet@0.2.0 version dist.integrity
```

Compare the integrity against `.runtime/package-check.json`, then install `nervelet@0.2.0` into a fresh project and run the [README embedding example](../README.md#embed-it-in-your-process). Consumers install with `npm install nervelet` and import from `nervelet` or a documented subpath. Keep release commits and tags tied to the tested archive's source.

See npm's [publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages) and [publish command](https://docs.npmjs.com/cli/v11/commands/npm-publish/) for account requirements and registry behavior.
