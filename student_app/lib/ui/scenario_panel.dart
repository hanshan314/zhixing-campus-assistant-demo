import 'package:flutter/material.dart';
import '../controllers/app_controller.dart';
import 'components.dart';
import 'style.dart';

class ScenarioPanel extends StatelessWidget {
  const ScenarioPanel({
    super.key,
    required this.controller,
    this.taskActions = false,
  });
  final AppController controller;
  final bool taskActions;

  @override
  Widget build(BuildContext context) => Panel(
    color: const Color(0xFFF1F3EE),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Row(
          children: [
            Icon(Icons.science_outlined, size: 20, color: mutedInk),
            SizedBox(width: 8),
            Expanded(
              child: Text(
                '仅改变本机虚拟场景',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: mutedInk,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        const Text(
          '这些控制用于检查失败后的提示与恢复，不是普通学生的正式业务权限。',
          style: TextStyle(fontSize: 12, height: 1.6, color: mutedInk),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _button('启用 AI 检查超时', 'ai_failure'),
            _button('下次提交丢失响应', 'drop_next_submit_response'),
            _button('下次上传丢失响应', 'drop_next_upload_response'),
            _button('下次草稿绑定丢失响应', 'drop_next_patch_response'),
            _button('下次检查等待补充', 'waiting_input'),
            _button('下次执行控制丢失响应', 'drop_next_run_response'),
            _button('下次消息已读丢失响应', 'drop_next_notification_response'),
            if (taskActions && controller.task != null) ...[
              _button('更新此任务要求', 'requirements_changed'),
              if (controller.task!.effectiveSubmission != null)
                _button('退回当前有效提交', 'review_needs_revision'),
              if (controller.task!.wire['status'] != 'withdrawn')
                _button('撤销此虚拟任务', 'withdraw_task'),
            ],
          ],
        ),
        const SizedBox(height: 12),
        Text(
          taskActions
              ? '要求变更和撤销会保留历史。退回不会新增学生人数；补交仍须从草稿开始。'
              : 'AI 超时启用后将影响后续检查，文件仍保留；响应丢失只影响下一次提交。任务变更和退回实验可在对应任务底部操作。',
          style: const TextStyle(fontSize: 11, height: 1.6, color: mutedInk),
        ),
      ],
    ),
  );

  Widget _button(String label, String scenario) => OutlinedButton(
    onPressed: controller.busy || !controller.connected
        ? null
        : () => controller.setScenario(scenario),
    style: OutlinedButton.styleFrom(
      backgroundColor: Colors.white,
      foregroundColor: mutedInk,
      textStyle: const TextStyle(fontSize: 12),
    ),
    child: Text(label),
  );
}
