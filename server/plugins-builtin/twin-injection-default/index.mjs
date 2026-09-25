/** System default Hybrid Twin plugin: the injection greybox is loaded through
 * the same external provider contract used by third-party industrial scenes. */
export default {
  name: 'twin-injection-default',
  version: '1.0.0',
  description: '系统自带注塑 Hybrid Twin 灰箱 Provider 与 ScenePack',
  auth: 'none',
  setup(ctx) {
    // The provider is registered by the Nitro bootstrap through the same Twin
    // Registry. This metadata plugin exists so the default provider is visible
    // in the normal plugin manifest and follows plugin enable/disable policy.
    ctx.logger.info('默认注塑 Twin Provider 由系统启动引导注册')
  },

}
