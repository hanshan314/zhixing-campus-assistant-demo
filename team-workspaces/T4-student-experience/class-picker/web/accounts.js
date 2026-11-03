window.PickerAccounts = class PickerAccounts {
  constructor({ request, modal, closeModal, notify, receive, setBusy, isBusy }) {
    Object.assign(this,{ request,modal,closeModal,notify,receive,setBusy,isBusy,account:null,spaceId:null,spaces:[],scenarios:{},mode:'login',hasLegacy:false });
    this.$ = id => document.getElementById(id);
    this.escape = v => String(v ?? '').replace(/[&<>"']/g,c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
    this.$('login-tab').addEventListener('click',() => this.setMode('login'));
    this.$('register-tab').addEventListener('click',() => this.setMode('register'));
    this.$('auth-form').addEventListener('submit',e => { e.preventDefault(); this.submit(); });
    this.$('space-select').addEventListener('change',() => this.switchSpace(this.$('space-select').value));
    this.$('new-space-button').addEventListener('click',() => this.showCreateSpace());
    this.$('account-button').addEventListener('click',() => this.showAccount());
  }
  rememberedSpace() { try { return sessionStorage.getItem('picker-space:'+this.account.id); } catch { return null; } }
  apply(data) {
    this.account = data.account; this.spaceId = data.spaceId; this.spaces = data.spaces; this.scenarios = data.scenarios;
    try { sessionStorage.setItem('picker-space:'+this.account.id,this.spaceId); } catch {}
    this.$('auth-screen').hidden = true; this.$('workspace').hidden = false;
    this.$('account-name').textContent = this.account.displayName;
    this.$('account-role').textContent = this.scenarios[this.account.role].role;
    this.$('account-avatar').textContent = this.account.displayName.slice(0,1);
    this.$('space-select').innerHTML = this.spaces.map(s => `<option value="${this.escape(s.id)}">${this.escape(s.name)} · ${this.escape(this.scenarios[s.scenario].label)}</option>`).join('');
    this.$('space-select').value = this.spaceId;
    this.$('auth-password').value = ''; this.$('auth-password-repeat').value = '';
    this.receive(data.state);
  }
  signedOut(message = '') {
    this.account = null; this.spaceId = null; this.spaces = [];
    this.receive(null);
    this.$('workspace').hidden = true; this.$('auth-screen').hidden = false;
    if (this.$('modal').open) this.$('modal').close();
    this.setMode('login'); this.$('auth-error').textContent = message;
    this.$('auth-password').value = ''; this.$('auth-password-repeat').value = '';
  }
  async refresh(preferred) {
    const data = await this.request('auth'); this.scenarios = data.scenarios;
    if (!data.authenticated) {
      this.hasLegacy = data.hasLegacy; this.signedOut(); this.setMode(data.hasAccounts ? 'login' : 'register'); return;
    }
    const previousAccount = this.account?.id;
    this.account = data.account;
    const choice = (previousAccount === data.account.id && preferred) || this.rememberedSpace();
    const chosen = data.spaces.find(s => s.id === choice);
    this.apply(chosen ? await this.request('state?spaceId='+encodeURIComponent(chosen.id)) : data);
  }
  setMode(mode) {
    this.mode = mode; const register = mode === 'register';
    this.$('register-fields').hidden = !register; this.$('password-repeat-label').hidden = !register;
    this.$('auth-display').required = register; this.$('auth-password-repeat').required = register;
    this.$('legacy-label').hidden = !register || !this.hasLegacy;
    this.$('login-tab').setAttribute('aria-selected',String(!register)); this.$('register-tab').setAttribute('aria-selected',String(register));
    this.$('auth-title').textContent = register ? '创建你的专属空间。' : '欢迎回来。';
    this.$('auth-description').textContent = register ? '选择你的身份，开启第一场公平抽签。' : '登录账号，继续管理你的抽签场景。';
    this.$('auth-password').autocomplete = register ? 'new-password' : 'current-password';
    this.$('auth-submit').textContent = register ? '创建账号并开始 →' : '登录并进入工作台 →';
    this.$('auth-error').textContent = '';
  }
  async submit() {
    if (this.isBusy()) return;
    if (this.mode === 'register' && this.$('auth-password').value !== this.$('auth-password-repeat').value) { this.$('auth-error').textContent = '两次输入的密码不一致'; return; }
    const payload = { username:this.$('auth-username').value,password:this.$('auth-password').value };
    if (this.mode === 'register') Object.assign(payload,{ displayName:this.$('auth-display').value,role:this.$('auth-role').value,adoptLegacy:!this.$('legacy-label').hidden && this.$('adopt-legacy').checked });
    await this.run('auth/'+(this.mode === 'register' ? 'register' : 'login'),payload);
  }
  async run(path,payload) {
    if (this.isBusy()) return;
    this.setBusy(true);
    try {
      const data = await this.request(path,payload);
      this.setBusy(false);
      if (data.authenticated) { this.apply(data); this.closeModal(); }
      else this.signedOut();
      this.notify(data.message); return data;
    } catch (e) {
      this.setBusy(false);
      (this.$('modal').open ? this.$('modal-error') : this.$('auth-error')).textContent = e.message;
      return null;
    }
  }
  async switchSpace(id) {
    if (this.isBusy()) return;
    this.setBusy(true);
    try { const data = await this.request('state?spaceId='+encodeURIComponent(id)); this.setBusy(false); this.apply(data); }
    catch (e) { this.setBusy(false); this.$('space-select').value = this.spaceId || ''; this.notify(e.message); }
  }
  showCreateSpace() {
    if (this.isBusy()) return;
    const role = this.account.role;
    this.modal('新建一个抽签场景',`<p class="modal-copy">每个场景单独保存名单、参与次数与活动历史。你可以为多个班级、社团或部门分别建立场景。</p><form id="space-form" class="modal-form"><div class="scene-options">${Object.entries(this.scenarios).map(([id,s]) => `<label class="scene-option"><input type="radio" name="scenario" value="${id}" ${id === role ? 'checked' : ''}><span class="scene-option-icon">${s.icon}</span><strong>${s.label}</strong><small>${s.description}</small></label>`).join('')}</div><label>场景名称<input id="space-name" type="text" maxlength="40" value="${this.escape(this.scenarios[role].defaultName)}" required placeholder="例如：高一任教班级 / 摄影社 / 宣传部"></label><div class="modal-actions"><button id="space-cancel" type="button" class="button secondary">取消</button><button class="button primary" type="submit">创建场景</button></div></form>`,() => {
      this.$('space-cancel').addEventListener('click',this.closeModal);
      let previous = this.scenarios[role].defaultName;
      document.querySelectorAll('input[name=scenario]').forEach(input => input.addEventListener('change',() => {
        if (!this.$('space-name').value || this.$('space-name').value === previous) this.$('space-name').value = this.scenarios[input.value].defaultName;
        previous = this.scenarios[input.value].defaultName;
      }));
      this.$('space-form').addEventListener('submit',e => { e.preventDefault(); this.run('spaces',{ operation:'create',scenario:document.querySelector('input[name=scenario]:checked').value,name:this.$('space-name').value }); });
    });
  }
  showAccount() {
    if (this.isBusy()) return;
    const a = this.account;
    this.modal('我的本机账号',`<div class="account-summary"><span class="account-large-avatar">${this.escape(a.displayName.slice(0,1))}</span><div><strong>${this.escape(a.displayName)}</strong><small>@${this.escape(a.username)} · ${this.scenarios[a.role].role} · ${this.spaces.length} 个场景</small></div><button id="logout-button" type="button" class="button secondary small">退出登录</button></div><p class="modal-copy">修改显示名称或密码需要验证当前密码。保存后，其他窗口的旧登录会失效。</p><form id="account-form" class="modal-form"><label>显示名称<input id="account-display-edit" type="text" maxlength="30" value="${this.escape(a.displayName)}" required></label><label>当前密码<input id="account-current-password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required></label><label>新密码（不修改则留空）<input id="account-new-password" type="password" autocomplete="new-password" minlength="8" maxlength="128"></label><label>再次输入新密码<input id="account-repeat-password" type="password" autocomplete="new-password" minlength="8" maxlength="128"></label><div class="modal-actions"><button id="account-cancel" type="button" class="button secondary">取消</button><button type="submit" class="button primary">保存账号资料</button></div></form>`,() => {
      this.$('account-cancel').addEventListener('click',this.closeModal);
      this.$('logout-button').addEventListener('click',() => this.run('auth/logout',{}));
      this.$('account-form').addEventListener('submit',e => {
        e.preventDefault();
        if (this.$('account-new-password').value !== this.$('account-repeat-password').value) { this.$('modal-error').textContent = '两次输入的新密码不一致'; return; }
        this.run('auth/account',{ displayName:this.$('account-display-edit').value,currentPassword:this.$('account-current-password').value,newPassword:this.$('account-new-password').value });
      });
    });
  }
  deleteCurrentSpace() {
    if (this.isBusy()) return;
    const current = this.spaces.find(s => s.id === this.spaceId);
    this.modal('删除当前抽签场景？',`<p class="modal-copy danger-copy">将删除“${this.escape(current.name)}”的全部名单和活动记录，无法撤销。请先备份当前场景。其他场景和账号不受影响。</p><div class="modal-actions"><button id="delete-space-cancel" class="button secondary">取消</button><button id="delete-space-confirm" class="button danger">确认删除场景</button></div>`,() => {
      this.$('delete-space-cancel').addEventListener('click',this.closeModal);
      this.$('delete-space-confirm').addEventListener('click',() => this.run('spaces',{ operation:'delete',spaceId:this.spaceId,revision:current.revision }));
    });
  }
};
