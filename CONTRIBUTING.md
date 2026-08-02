# Contributing to HBD 3D Craft

First off, thank you for considering contributing to HBD 3D Craft! It's people like you who make this project such a fun and interactive experience for everyone.

When contributing to this repository, please first discuss the change you wish to make via issue, email, or any other method with the owners of this repository before making a change.

Please note we have a [Code of Conduct](./CODE_OF_CONDUCT.md), please follow it in all your interactions with the project.

## How Can I Contribute?

### Reporting Bugs
If you find a bug, please create a new issue. Include:
* A clear description of the bug.
* Steps to reproduce the behavior.
* Expected behavior vs. actual behavior.
* Screenshots or screen recordings if applicable.

### Suggesting Enhancements
We welcome ideas for new features (like new 3D decorations, themes, or music tracks). Please submit them as issues with the label `enhancement`.

### Pull Requests
1. Fork the repository and create your branch from `main`.
2. Install dependencies with `npm install`.
3. If you've added code that should be tested, add tests.
4. Ensure your code is clean and matches the project formatting style.
5. Issue a Pull Request with a clear description of the changes.

## Development Guidelines

* **WebGL/Three.js**: Keep code optimized for mobile devices (e.g. limit shadow maps, keep polygon counts low).
* **Styles**: Maintain responsive styling using CSS HSL variable design tokens.
* **i18n**: If adding UI components, ensure translation tokens are updated in `src/i18n.js`.

Thank you for your support!
