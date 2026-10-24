import 'package:flutter/material.dart';
import '../domain/models.dart';
import 'style.dart';

Json jsonMap(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : {};
List<Json> jsonList(dynamic value) => value is List
    ? value
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList()
    : [];

String chinaTime(dynamic value) {
  final date = DateTime.tryParse(value?.toString() ?? '');
  if (date == null) return '暂无记录';
  final local = date.toUtc().add(const Duration(hours: 8));
  String two(int part) => part.toString().padLeft(2, '0');
  return '${local.month}月${local.day}日 ${two(local.hour)}:${two(local.minute)}';
}

String fileSize(dynamic value) {
  final bytes = value is num ? value : 0;
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '$bytes B';
}

class DemoBanner extends StatelessWidget {
  const DemoBanner({super.key});
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
    color: const Color(0xFFEDF1E7),
    child: const Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(Icons.science_outlined, size: 16, color: teal),
        SizedBox(width: 7),
        Flexible(
          child: Text(
            '演示环境 · 仅虚拟材料',
            style: TextStyle(
              fontSize: 12,
              color: teal,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

class Panel extends StatelessWidget {
  const Panel({
    super.key,
    required this.child,
    this.color = Colors.white,
    this.padding = const EdgeInsets.all(20),
  });
  final Widget child;
  final Color color;
  final EdgeInsetsGeometry padding;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: padding,
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(22),
      border: Border.all(color: line),
    ),
    child: child,
  );
}

class SectionHeading extends StatelessWidget {
  const SectionHeading(this.title, {super.key, this.subtitle, this.trailing});
  final String title;
  final String? subtitle;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 24, bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleMedium),
              if (subtitle != null) ...[
                const SizedBox(height: 3),
                Text(subtitle!, style: Theme.of(context).textTheme.bodySmall),
              ],
            ],
          ),
        ),
        ?trailing,
      ],
    ),
  );
}

class SmallBadge extends StatelessWidget {
  const SmallBadge(
    this.label, {
    super.key,
    this.color = teal,
    this.background = paleTeal,
    this.icon,
  });
  final String label;
  final Color color;
  final Color background;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(9),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 5),
        ],
        Flexible(
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              height: 1.35,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ),
      ],
    ),
  );
}

class InfoBox extends StatelessWidget {
  const InfoBox(
    this.message, {
    super.key,
    this.title,
    this.warning = false,
    this.icon,
    this.action,
  });
  final String message;
  final String? title;
  final bool warning;
  final IconData? icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: warning ? paleOrange : paleTeal,
      borderRadius: BorderRadius.circular(16),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          icon ??
              (warning
                  ? Icons.info_outline_rounded
                  : Icons.lightbulb_outline_rounded),
          size: 20,
          color: warning ? warmOrange : teal,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (title != null) ...[
                Text(
                  title!,
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: warning ? warmOrange : teal,
                  ),
                ),
                const SizedBox(height: 4),
              ],
              Text(
                message,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.6,
                  color: warning
                      ? const Color(0xFF88542E)
                      : const Color(0xFF386C63),
                ),
              ),
              if (action != null) ...[const SizedBox(height: 10), action!],
            ],
          ),
        ),
      ],
    ),
  );
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    required this.message,
    this.icon = Icons.inbox_outlined,
    this.action,
  });
  final String title;
  final String message;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Panel(
    child: Column(
      children: [
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.all(20),
          decoration: const BoxDecoration(
            color: paleTeal,
            shape: BoxShape.circle,
          ),
          child: Icon(icon, size: 35, color: teal),
        ),
        const SizedBox(height: 18),
        Text(
          title,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          message,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (action != null) ...[const SizedBox(height: 18), action!],
        const SizedBox(height: 12),
      ],
    ),
  );
}

class DetailLine extends StatelessWidget {
  const DetailLine(
    this.label,
    this.value, {
    super.key,
    this.selectable = false,
  });
  final String label;
  final String value;
  final bool selectable;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 82,
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        Expanded(
          child: selectable
              ? SelectableText(
                  value,
                  style: const TextStyle(fontSize: 13, height: 1.5, color: ink),
                )
              : Text(
                  value,
                  style: const TextStyle(fontSize: 13, height: 1.5, color: ink),
                ),
        ),
      ],
    ),
  );
}

class TaskTile extends StatelessWidget {
  const TaskTile({
    super.key,
    required this.task,
    required this.onTap,
    this.enabled = true,
  });
  final CampusTask task;
  final VoidCallback onTap;
  final bool enabled;
  @override
  Widget build(BuildContext context) {
    final urgent =
        task.status == 'needs_revision' || task.state['is_overdue'] == true;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: line),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(11),
                      decoration: BoxDecoration(
                        color: urgent ? paleOrange : paleTeal,
                        borderRadius: BorderRadius.circular(13),
                      ),
                      child: Icon(
                        urgent
                            ? Icons.edit_note_rounded
                            : Icons.assignment_outlined,
                        color: urgent ? warmOrange : teal,
                        size: 23,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            task.title,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            task.deadlineLabel,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.only(top: 10),
                      child: Icon(
                        Icons.chevron_right_rounded,
                        size: 22,
                        color: mutedInk,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Wrap(
                  spacing: 8,
                  runSpacing: 7,
                  children: [
                    SmallBadge(
                      statusLabel(task.status),
                      color: urgent ? warmOrange : teal,
                      background: urgent ? paleOrange : paleTeal,
                    ),
                    SmallBadge(
                      '要求 v${task.requirementVersion}',
                      color: mutedInk,
                      background: const Color(0xFFF2F4F1),
                    ),
                    if (task.state['is_overdue'] == true)
                      const SmallBadge(
                        '已逾期',
                        color: warmOrange,
                        background: paleOrange,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
