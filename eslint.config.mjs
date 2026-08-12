import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // 项目级规则覆盖
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      '@stylistic/semi': ['error', 'never'],
    },
  },
)
