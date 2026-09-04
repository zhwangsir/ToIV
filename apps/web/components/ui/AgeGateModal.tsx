"use client";

/**
 * 18+ 年龄确认弹层(M9:NSFW 整合主站,自 NsfwView 抽离为全局组件)。
 *
 * 开启 R18 模式前强制确认;确认写 localStorage(toiv_nsfw_age_confirmed,见 lib/r18.ts)。
 * 文案与原专区年龄门一致;取消不写入任何记录。
 */
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

interface AgeGateModalProps {
  open: boolean;
  /** 确认已满 18 岁(调用方负责 confirmAge() + 后续放行) */
  onConfirm: () => void;
  /** 取消/离开(不写入任何确认记录) */
  onCancel: () => void;
}

export function AgeGateModal({ open, onConfirm, onCancel }: AgeGateModalProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="年龄确认"
      danger
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            我已年满 18 岁,开启 R18 模式
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: "var(--leading-loose)", color: "var(--text-secondary)" }}>
        R18 模式将展示成人向(18+)创作功能与内容,包括成人向生成引擎、
        作品库中的 R18 作品及推荐模型。继续即表示你确认已年满 18 岁,
        并承诺遵守所在地法律法规。可随时在设置中关闭。
      </p>
    </Modal>
  );
}
