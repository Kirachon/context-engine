# AI Context Engine & MCP Server Indexing Best Practices

> **Purpose**: Guide for configuring file inclusion/exclusion in AI context engines and Model Context Protocol (MCP) servers to optimize performance, context quality, and token efficiency.

---

## 📋 Table of Contents

- [DO INDEX - Files to Include](#do-index---files-to-include)
  - [Essential Files (High Priority)](#essential-files-high-priority)
  - [Recommended Files (Medium Priority)](#recommended-files-medium-priority)
  - [Conditional Files (Low Priority)](#conditional-files-low-priority)
- [DON'T INDEX - Files to Exclude](#dont-index---files-to-exclude)
  - [Generated Code](#generated-code)
  - [Lock Files & Dependencies](#lock-files--dependencies)
  - [Binary & Media Files](#binary--media-files)
  - [Build Artifacts & Temporary Files](#build-artifacts--temporary-files)
  - [IDE & System Files](#ide--system-files)
- [Performance Guidelines](#performance-guidelines)
- [Flutter/Dart Specific Recommendations](#flutterdart-specific-recommendations)

---

## ✅ DO INDEX - Files to Include

### Essential Files (High Priority)

**Always include these files for optimal AI context and code understanding.**

#### Source Code Files

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.dart` | Dart source files | Core application logic, business rules, UI components |
| `.ts`, `.tsx` | TypeScript files | Web frontend logic, type definitions |
| `.js`, `.jsx` | JavaScript files | Web scripts, configuration, utilities |
| `.py` | Python files | Backend services, scripts, automation |
| `.sql` | SQL files | Database schemas, migrations, queries |
| `.sh`, `.bash` | Shell scripts | Build scripts, deployment automation |

**Why**: Source code contains the actual business logic and application behavior that AI needs to understand for code generation, debugging, and refactoring.

#### Documentation Files

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.md` | Markdown documentation | README files, API docs, architecture decisions |
| `.txt` | Plain text files | Notes, changelogs, simple documentation |

**Why**: Documentation provides high-level context about project structure, design decisions, and usage patterns that improve AI understanding.

#### Configuration Files

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.yaml`, `.yml` | YAML configuration | CI/CD configs, Docker compose, pubspec.yaml |
| `.json` | JSON configuration | package.json, tsconfig.json, settings files |
| `.toml` | TOML configuration | Rust configs, Python pyproject.toml |
| `.xml` | XML configuration | Android manifests, Maven configs |
| `.env.example` | Environment templates | Example environment variables (not actual .env) |

**Why**: Configuration files define project dependencies, build settings, and environment setup crucial for understanding project structure.

#### Special Files

| File/Pattern | Description | Rationale |
|--------------|-------------|-----------|
| `pubspec.yaml` | Flutter dependencies | Critical for understanding Flutter project structure |
| `analysis_options.yaml` | Dart linter config | Code quality rules and standards |
| `Makefile` | Build automation | Build commands and project tasks |
| `Dockerfile` | Container config | Deployment and runtime environment |
| `.arb` | Internationalization | Flutter localization files |

---

### Recommended Files (Medium Priority)

**Include these for enhanced context, especially when working on specific features.**

#### Platform-Specific Code

| Extension | Platform | When to Include |
|-----------|----------|-----------------|
| `.swift`, `.m`, `.h` | iOS/macOS | Working on iOS native features |
| `.kt`, `.kts` | Android (Kotlin) | Working on Android native features |
| `.java` | Android (Java) | Legacy Android code |
| `.cpp`, `.cc`, `.h` | Native C++ | Flutter FFI or native plugins |
| `.gradle`, `.gradle.kts` | Android build | Android build configuration |
| `.plist` | iOS config | iOS app configuration |
| `.xcconfig` | Xcode config | iOS build settings |

**Why**: Platform-specific code is only relevant when working on native integrations or platform-specific features.

#### Testing & Quality

| Extension | Description | When to Include |
|-----------|-------------|-----------------|
| `.dart` (test files) | Dart tests | Understanding test coverage and behavior |
| `.spec.ts`, `.test.ts` | TypeScript tests | Web component testing |
| `.py` (test files) | Python tests | Backend testing |

**Special Consideration**: Include test files for understanding expected behavior, but exclude large test fixture files and mock data.

---

### Conditional Files (Low Priority)

**Include only when specifically needed for the task at hand.**

| Extension | Description | When to Include |
|-----------|-------------|-----------------|
| `.csv` | Data files | Small reference data or configuration |
| `.graphql`, `.gql` | GraphQL schemas | Working with GraphQL APIs |
| `.proto` | Protocol buffers | Working with gRPC or protobuf |
| `.html` | HTML templates | Web frontend work |
| `.css`, `.scss` | Stylesheets | UI styling work |

**Performance Note**: Only include these when actively working on related features to avoid token waste.

---

## ❌ DON'T INDEX - Files to Exclude

### Generated Code

**Exclude all auto-generated files that are recreated by build tools.**

| Pattern | Description | Rationale |
|---------|-------------|-----------|
| `*.g.dart` | Generated Dart code | Created by build_runner, json_serializable |
| `*.freezed.dart` | Freezed generated code | Auto-generated immutable classes |
| `*.mocks.dart` | Mockito mocks | Auto-generated test mocks |
| `*.pb.dart` | Protobuf generated | Auto-generated from .proto files |
| `*.gr.dart` | Auto_route generated | Auto-generated routing code |

**Why**: Generated code is:
- **Verbose and token-heavy** (wastes context budget)
- **Not human-editable** (changes get overwritten)
- **Regenerated automatically** (no need to track)
- **Contains repetitive patterns** (low information density)

**Exception**: Include if you've manually modified generated files (rare and not recommended).

---

### Lock Files & Dependencies

**Exclude dependency lock files and vendored dependencies.**

| File/Pattern | Description | Rationale |
|--------------|-------------|-----------|
| `pubspec.lock` | Flutter/Dart lock | Auto-generated dependency resolution |
| `package-lock.json` | npm lock file | Auto-generated npm dependencies |
| `yarn.lock` | Yarn lock file | Auto-generated Yarn dependencies |
| `pnpm-lock.yaml` | pnpm lock file | Auto-generated pnpm dependencies |
| `Gemfile.lock` | Ruby lock file | Auto-generated Ruby dependencies |
| `poetry.lock` | Python Poetry lock | Auto-generated Python dependencies |
| `Cargo.lock` | Rust lock file | Auto-generated Rust dependencies |
| `composer.lock` | PHP lock file | Auto-generated PHP dependencies |
| `bun.lockb` | Bun lock file | Binary lock file |

**Why**: Lock files are:
- **Machine-generated** (not human-readable)
- **Extremely verbose** (thousands of lines)
- **Low value for AI** (dependency versions rarely needed)
- **Waste tokens** (better to reference pubspec.yaml/package.json)

---

### Binary & Media Files

**Exclude all binary files, images, fonts, and media assets.**

#### Images & Graphics

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.png`, `.jpg`, `.jpeg` | Raster images | Binary format, no code context |
| `.gif`, `.webp`, `.bmp` | Image formats | Binary format, no code context |
| `.svg` | Vector graphics | Sometimes useful, but often large |
| `.ico`, `.icns` | Icon files | Binary format |
| `.psd`, `.ai`, `.sketch` | Design files | Binary design tools |

**Why**: Binary image files cannot be read as text and provide no value to AI code understanding.

**Exception**: Small SVG files might be useful if they contain programmatically generated graphics, but generally exclude.

#### Fonts & Typography

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.ttf`, `.otf` | TrueType/OpenType fonts | Binary font files |
| `.woff`, `.woff2` | Web fonts | Compressed binary fonts |
| `.eot` | Embedded OpenType | Legacy web fonts |

**Why**: Font files are binary and irrelevant to code logic.

#### Documents & Archives

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.pdf` | PDF documents | Binary format |
| `.doc`, `.docx` | Word documents | Binary/compressed format |
| `.xls`, `.xlsx` | Excel spreadsheets | Binary/compressed format |
| `.ppt`, `.pptx` | PowerPoint | Binary/compressed format |
| `.zip`, `.tar`, `.gz` | Archives | Compressed binary |
| `.7z`, `.rar` | Archives | Compressed binary |

**Why**: Binary document formats cannot be parsed as code and waste indexing resources.

#### Media Files

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.mp3`, `.wav`, `.ogg` | Audio files | Binary media |
| `.mp4`, `.mov`, `.avi` | Video files | Binary media |
| `.webm`, `.flv` | Video formats | Binary media |

**Why**: Media files are large binary files with no code relevance.

#### Compiled & Executable Files

| Extension | Description | Rationale |
|-----------|-------------|-----------|
| `.exe`, `.dll` | Windows executables | Binary compiled code |
| `.so`, `.dylib` | Unix/Mac libraries | Binary compiled code |
| `.a`, `.lib` | Static libraries | Binary compiled code |
| `.jar`, `.war` | Java archives | Compiled bytecode |
| `.pyc`, `.pyo` | Python bytecode | Compiled Python |
| `.class` | Java bytecode | Compiled Java |
| `.o`, `.obj` | Object files | Compiled intermediate |
| `.dill` | Dart kernel | Compiled Dart |

**Why**: Compiled binaries are not human-readable and are regenerated from source code.

---

### Build Artifacts & Temporary Files

**Exclude all build outputs, caches, and temporary files.**

#### Flutter/Dart Build Outputs

| Directory/Pattern | Description | Rationale |
|-------------------|-------------|-----------|
| `build/` | Flutter build output | Generated compiled code |
| `.dart_tool/` | Dart tooling cache | Package cache and build info |
| `.flutter-plugins` | Plugin registry | Auto-generated plugin list |
| `.flutter-plugins-dependencies` | Plugin dependencies | Auto-generated dependency graph |
| `*.dill` | Dart kernel snapshots | Compiled Dart bytecode |
| `*.stamp` | Build timestamps | Build system markers |

#### Platform-Specific Build Outputs

| Directory | Platform | Rationale |
|-----------|----------|-----------|
| `android/build/` | Android | Gradle build outputs |
| `android/.gradle/` | Android | Gradle cache |
| `android/app/build/` | Android | App build artifacts |
| `ios/Pods/` | iOS | CocoaPods dependencies |
| `ios/.symlinks/` | iOS | Flutter symlinks |
| `ios/Flutter/ephemeral/` | iOS | Temporary Flutter files |
| `macos/Flutter/ephemeral/` | macOS | Temporary Flutter files |
| `windows/flutter/ephemeral/` | Windows | Temporary Flutter files |
| `linux/flutter/ephemeral/` | Linux | Temporary Flutter files |

#### Web & Node.js Build Outputs

| Directory | Description | Rationale |
|-----------|-------------|-----------|
| `node_modules/` | npm packages | Vendored dependencies (huge) |
| `dist/` | Distribution build | Compiled/bundled output |
| `.next/` | Next.js build | Generated Next.js files |
| `.nuxt/` | Nuxt.js build | Generated Nuxt.js files |
| `out/` | Build output | Generic build directory |
| `.cache/` | Build cache | Temporary cache files |
| `*.min.js` | Minified JavaScript | Unreadable compressed code |
| `*.min.css` | Minified CSS | Unreadable compressed styles |
| `*.map` | Source maps | Large mapping files |

#### Python Build Outputs

| Directory/Pattern | Description | Rationale |
|-------------------|-------------|-----------|
| `__pycache__/` | Python cache | Compiled bytecode cache |
| `.pytest_cache/` | Pytest cache | Test framework cache |
| `.venv/`, `venv/` | Virtual environment | Python dependencies |
| `*.egg-info/` | Package metadata | Build metadata |
| `dist/` | Distribution | Built packages |

**Why**: Build artifacts are:
- **Regenerated on every build** (no need to track)
- **Large and numerous** (performance impact)
- **Not human-editable** (derived from source)
- **Waste indexing resources** (no value for AI)

---

### IDE & System Files

**Exclude IDE configurations and system-generated files.**

#### IDE Configuration

| Directory/Pattern | IDE | Rationale |
|-------------------|-----|-----------|
| `.idea/` | IntelliJ/Android Studio | IDE-specific settings |
| `.vscode/` | Visual Studio Code | Editor settings (sometimes useful) |
| `.vs/` | Visual Studio | IDE cache and settings |
| `*.iml` | IntelliJ modules | IDE module files |
| `.project`, `.classpath` | Eclipse | Eclipse project files |
| `*.swp`, `*.swo` | Vim | Vim swap files |
| `.DS_Store` | macOS | macOS folder metadata |

**Exception**: `.vscode/launch.json` and `.vscode/tasks.json` might be useful for understanding debug/build configurations.

#### Version Control

| Directory | System | Rationale |
|-----------|--------|-----------|
| `.git/` | Git | Version control internals |
| `.svn/` | Subversion | Version control internals |
| `.hg/` | Mercurial | Version control internals |

**Why**: Version control internals are binary/compressed and not relevant to code understanding.

**Note**: Use `git` commands to query history, not by indexing `.git/` directory.

#### Environment & Secrets

| Pattern | Description | Rationale |
|---------|-------------|-----------|
| `.env` | Environment variables | Contains secrets (security risk) |
| `.env.local` | Local environment | Contains secrets |
| `.env.production` | Production env | Contains secrets |
| `*.key`, `*.pem` | Private keys | Security sensitive |
| `*.p12`, `*.jks` | Keystores | Security sensitive |
| `secrets.yaml` | Secret configs | Security sensitive |

**Why**: Exclude to prevent accidentally exposing secrets to AI services.

**Exception**: `.env.example` or `.env.template` files should be included as they document required environment variables.

---

## 📊 Performance Guidelines

### File Size Limits

| Limit | Recommendation | Rationale |
|-------|----------------|-----------|
| **Max file size** | 1 MB | Files larger than 1MB are often generated or data files |
| **Max total files** | 500-1000 | Balance coverage with indexing performance |
| **Target coverage** | 60-70% | Exclude 30-40% of files for optimal performance |

### Token Budget Optimization

**Best Practices:**
1. **Prioritize source code** over configuration and documentation
2. **Exclude generated code** to save 20-40% of tokens
3. **Exclude lock files** to save 10-20% of tokens
4. **Exclude binary files** to prevent indexing failures
5. **Use selective indexing** for large monorepos (index only relevant packages)

### Indexing Performance Impact

| File Type | Impact | Recommendation |
|-----------|--------|----------------|
| Source code (`.dart`, `.ts`, `.py`) | ✅ Low | Always index |
| Documentation (`.md`) | ✅ Low | Always index |
| Configuration (`.yaml`, `.json`) | ✅ Low | Always index |
| Generated code (`.g.dart`) | ⚠️ High | Exclude |
| Lock files (`.lock`) | ⚠️ High | Exclude |
| Binary files (images, fonts) | ❌ Critical | Always exclude |
| `node_modules/` | ❌ Critical | Always exclude |

---

## 🎯 Flutter/Dart Specific Recommendations

### Essential Flutter Files to Index

```
✅ lib/**/*.dart          # All application source code
✅ test/**/*.dart         # Test files (understand behavior)
✅ pubspec.yaml           # Dependencies and project config
✅ analysis_options.yaml  # Linter and analyzer settings
✅ *.arb                  # Internationalization files
✅ android/app/src/main/AndroidManifest.xml
✅ ios/Runner/Info.plist
✅ README.md
✅ CHANGELOG.md
```

### Flutter Files to Exclude

```
❌ pubspec.lock                    # Auto-generated lock file
❌ .dart_tool/**                   # Dart tooling cache
❌ build/**                        # Build outputs
❌ **/*.g.dart                     # Generated code (json_serializable)
❌ **/*.freezed.dart               # Generated code (freezed)
❌ **/*.mocks.dart                 # Generated code (mockito)
❌ **/*.gr.dart                    # Generated code (auto_route)
❌ .flutter-plugins                # Generated plugin registry
❌ .flutter-plugins-dependencies   # Generated dependencies
❌ android/build/**                # Android build outputs
❌ android/.gradle/**              # Gradle cache
❌ ios/Pods/**                     # CocoaPods dependencies
❌ ios/.symlinks/**                # Flutter symlinks
❌ ios/Flutter/ephemeral/**        # Temporary iOS files
❌ macos/Flutter/ephemeral/**      # Temporary macOS files
❌ windows/flutter/ephemeral/**    # Temporary Windows files
❌ linux/flutter/ephemeral/**      # Temporary Linux files
```

### Flutter Project Structure Example

```
my_flutter_app/
├── lib/                    ✅ INDEX (all .dart files)
│   ├── models/
│   │   ├── user.dart       ✅ INDEX
│   │   └── user.g.dart     ❌ EXCLUDE (generated)
│   ├── services/
│   └── main.dart           ✅ INDEX
├── test/                   ✅ INDEX (test files)
├── pubspec.yaml            ✅ INDEX
├── pubspec.lock            ❌ EXCLUDE
├── analysis_options.yaml   ✅ INDEX
├── .dart_tool/             ❌ EXCLUDE (entire directory)
├── build/                  ❌ EXCLUDE (entire directory)
├── android/
│   ├── app/src/main/AndroidManifest.xml  ✅ INDEX
│   └── build/              ❌ EXCLUDE
└── ios/
    ├── Runner/Info.plist   ✅ INDEX
    └── Pods/               ❌ EXCLUDE
```

---

## 🔧 Implementation Examples

### Example `.cursorignore` / `.augmentignore`

```gitignore
# Generated Code
**/*.g.dart
**/*.freezed.dart
**/*.mocks.dart
**/*.gr.dart

# Lock Files
pubspec.lock
package-lock.json
yarn.lock
pnpm-lock.yaml

# Build Outputs
build/
.dart_tool/
dist/
out/

# Platform Build Outputs
android/build/
android/.gradle/
ios/Pods/
ios/.symlinks/
**/Flutter/ephemeral/

# Dependencies
node_modules/
.venv/

# Binary Files
*.png
*.jpg
*.jpeg
*.gif
*.svg
*.ttf
*.woff
*.woff2
*.pdf
*.zip
*.exe
*.dll
*.so

# IDE
.idea/
.vs/
*.iml

# System
.DS_Store
.git/

# Secrets
.env
.env.local
*.key
*.pem
```

### Example MCP Server Configuration

```json
{
  "indexing": {
    "include_extensions": [
      ".dart",
      ".ts", ".js",
      ".py",
      ".md",
      ".yaml", ".yml",
      ".json",
      ".sql"
    ],
    "exclude_extensions": [
      ".g.dart",
      ".freezed.dart",
      ".lock",
      ".min.js",
      ".map",
      ".png", ".jpg",
      ".ttf", ".woff"
    ],
    "exclude_directories": [
      "build/",
      ".dart_tool/",
      "node_modules/",
      "android/build/",
      "ios/Pods/",
      ".git/"
    ],
    "max_file_size_mb": 1
  }
}
```

---

## 📚 References & Sources

- **Cursor Documentation**: `.cursorignore` best practices
- **GitHub Semantic Search**: Code indexing patterns
- **Sourcegraph**: Enterprise code search exclusions
- **Model Context Protocol (MCP)**: Server implementation patterns
- **GitHub Copilot**: Context window optimization
- **Codeium**: AI context engine design

---

## 🎓 Key Takeaways

1. **Prioritize source code** - Focus on `.dart`, `.ts`, `.py`, and other human-written code
2. **Exclude generated code** - Save 20-40% of tokens by excluding `.g.dart`, `.freezed.dart`, etc.
3. **Exclude lock files** - `pubspec.lock`, `package-lock.json` waste tokens
4. **Exclude binaries** - Images, fonts, and compiled files provide no value
5. **Exclude build outputs** - `build/`, `.dart_tool/`, `node_modules/` are regenerated
6. **Include documentation** - `.md` files provide valuable context
7. **Include configuration** - `pubspec.yaml`, `.json`, `.yaml` define project structure
8. **Set file size limits** - Exclude files >1MB to prevent performance issues
9. **Target 60-70% coverage** - Quality over quantity for optimal AI performance
10. **Protect secrets** - Always exclude `.env` and credential files

---

**Last Updated**: 2025-12-13
**Version**: 1.0.0
**Maintained by**: AI Context Engine Best Practices Working Group

