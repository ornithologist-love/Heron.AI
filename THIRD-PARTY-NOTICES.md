# Third-party notices

The root [MIT license](LICENSE) covers Heron.AI's first-party source. It does not replace the copyright notices or licenses of third-party components, including dependencies, submodules, fonts, native binaries and artwork.

The source distribution retains these upstream licenses:

| Component | License | Original notice |
| --- | --- | --- |
| DeepSeek Harness and its separately licensed components | MIT and component-specific notices | [DSH license](packages/dsh/LICENSE); retain notices within that submodule |
| DSH MCP Manager | MIT | [License](packages/community/dsh-mcp-manager/LICENSE) |
| DSH Skill Manager | MIT | [License](packages/community/dsh-skill-manager/LICENSE) |
| DSH Better Sidebar | MIT | [License](packages/community/dsh-better-sidebar/LICENSE) |
| Model icons from LobeHub | MIT | [Original notice](packages/common/runtime/assets/model-logos/LICENSE.lobe-icons) |
| Xiaomi icon from Simple Icons | CC0 1.0 | [Original notice](packages/common/runtime/assets/model-logos/LICENSE.simple-icons) |

Installed npm and NuGet dependencies retain their own licenses. The runtime keeps the notices shipped in retained dependency packages; the source lockfile and submodule revisions identify the selected versions. Product names and logos remain the property of their respective owners.

The runtime copies its first-party license and this notice to AiHost. Source links in that runtime copy refer to the corresponding source distribution; dependency-specific notices remain alongside the installed dependencies.
