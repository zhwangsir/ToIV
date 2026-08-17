"use client";

import { useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Popover } from "@/components/ui/Popover";
import { ThemePicker } from "@/components/ui/ThemePicker";
import { useR18Mode } from "@/lib/r18";

interface AccountButtonProps {
  account: string;
  onLogout?: () => void;
  /** 打开设置视图(走统一视图切换,含预热/过渡) */
  onOpenSettings: () => void;
}

/**
 * 右上角账户按钮(2026-08-17 自灵动岛拆分):
 * 独立常驻头像,一跳直达主题/设置/退出——账户操作不再埋于导航面板第三层,
 * 与左上灵动岛对角呼应(左上品牌导航 / 右上账户身份,桌面应用惯例);
 * 桌面 ≥1024px 显示,窄屏由底部导航「更多 → 设置」承载。
 * Popover 走统一弹层基座(portal,滚动/Esc/外点关闭),材质玻璃。
 */
export function AccountButton({ account, onLogout, onOpenSettings }: AccountButtonProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // M9:订阅 R18 模式,菜单展示只读状态行(正式开关在设置页「内容偏好」)
  const [r18] = useR18Mode();

  return (
    <div className="accountbtn">
      <button
        ref={btnRef}
        type="button"
        className="accountbtn-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`账户 ${account}`}
        title={account}
      >
        <span className="accountbtn-avatar" aria-hidden="true">
          {account.charAt(0).toUpperCase()}
        </span>
      </button>

      <Popover
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        width={240}
        role="menu"
        ariaLabel="账户菜单"
      >
        <div className="accountbtn-pop">
          <div className="accountbtn-pop-email" title={account} translate="no">
            {account}
          </div>
          <ThemePicker />
          {r18 && (
            <div className="accountbtn-r18">
              <span className="accountbtn-r18-badge">18+</span>
              R18 模式已开启
            </div>
          )}
          <button
            type="button"
            className="accountbtn-action"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Icon name="settings" size={13} />
            设置
          </button>
          {onLogout && (
            <button type="button" className="accountbtn-logout" onClick={onLogout}>
              <Icon name="close" size={13} />
              退出登录
            </button>
          )}
        </div>
      </Popover>
    </div>
  );
}
