module.exports = {
  hooks: {
    readPackage(pkg) {
      // DSH is a source dependency of this product, not the owning Git repository.
      // Its contributor hooks assume a standalone checkout. Keep native dependency
      // lifecycles enabled and leave the upstream manifest and Git config untouched.
      if (pkg.name === '@deepseek-ai/dsh-root'
          && pkg.scripts?.postinstall === 'node scripts/install-lefthook.mjs') {
        pkg.scripts = { ...pkg.scripts }
        delete pkg.scripts.postinstall
      }
      return pkg
    },
  },
}
