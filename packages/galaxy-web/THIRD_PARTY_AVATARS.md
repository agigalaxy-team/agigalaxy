# Local account avatars

The application renders deterministic illustrations locally from the already preserved DiceBear 10.6.0 library and style definitions. It sends no account identifiers, names, or image requests to an external avatar service.

The real account ID selects a stable illustration. The saved avatarKey selects one of the existing eight visual variants. The recorded subjectType selects an appropriate style: person uses Personas, organization uses Shapes, and agent uses Bottts. Unknown types use a neutral Identicon; a name is never used to infer a type. The same ID, key, and recorded type produce the same image in the directory, profile, forum and private conversation. These are illustrations, not photographs or assertions of verified identity.

The existing picker previews each variant with the current account ID and recorded type, using the same generator as the saved view. No new avatar keys, database fields, or user settings are introduced.

## Preserved upstream sources and licenses

- DiceBear core 10.6.0: MIT. The complete core license and style metadata are retained beside the bundled source in src/vendor/account-avatar-generator.LICENSE.txt.
- Personas by Draftbit: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [source](https://github.com/draftbit/personas).
- Bottts by Pablo Stanley: the preserved style metadata permits personal and commercial use; [original project](https://bottts.com/).
- Shapes and Identicon by DiceBear: [CC0](https://creativecommons.org/publicdomain/zero/1.0/).

The preserved style-source commit is 22a9abebc54ed68275da811573204ad83db646b8; the generator-source commit is e798d55e6a3842ac25e6c53601a0a4010c235d02. The project-owned avatar continuity support retains the exact upstream archives, four style definitions, and bundle entry used to reproduce this browser module. No dependencies are fetched at runtime.
