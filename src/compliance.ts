/**
 * Compliance Export — Generate audit reports for SOC 2, GDPR, and HIPAA compliance.
 *
 * Formats audit events into structured compliance reports with:
 *   - Report metadata (period, generation time, framework, version)
 *   - Access control events (key management, auth failures)
 *   - Data processing events (tool calls, credit operations)
 *   - Configuration changes (config reload, webhook updates)
 *   - Summary statistics
 */

import { AuditEvent, AuditLogger, AuditQuery } from './audit';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ComplianceFramework = 'soc2' | 'gdpr' | 'hipaa';

export interface ComplianceReportMeta {
  framework: ComplianceFramework;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  serverVersion: string;
  totalEvents: number;
}

export interface ComplianceSection {
  title: string;
  description: string;
  events: ComplianceEvent[];
  count: number;
}

export interface ComplianceEvent {
  timestamp: string;
  category: string;
  action: string;
  actor: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  metadata?: Record<string, unknown>;
}

export interface ComplianceReport {
  meta: ComplianceReportMeta;
  sections: ComplianceSection[];
  summary: ComplianceSummary;
}

export interface ComplianceSummary {
  totalAccessControlEvents: number;
  totalDataProcessingEvents: number;
  totalConfigChangeEvents: number;
  totalSecurityEvents: number;
  authFailures: number;
  keysCreated: number;
  keysRevoked: number;
  keysSuspended: number;
  uniqueActors: number;
}

// ─── Event Classification ─────────────────────────────────────────────────────

const ACCESS_CONTROL_EVENTS = new Set([
  'key.created', 'key.revoked', 'key.suspended', 'key.resumed', 'key.cloned',
  'key.rotated', 'key.acl_updated', 'key.expiry_updated', 'key.ip_updated',
  'admin.auth_failed', 'admin_key.created', 'admin_key.revoked',
  'admin_key.bootstrap_rotated', 'oauth.client_registered',
  'oauth.token_issued', 'oauth.token_revoked', 'token.created', 'token.revoked',
  'team.key_assigned', 'team.key_removed', 'group.key_assigned', 'group.key_removed',
]);

const DATA_PROCESSING_EVENTS = new Set([
  'gate.allow', 'gate.deny', 'key.topup', 'key.auto_topped_up',
  'key.credits_transferred', 'credits.reserved', 'credits.committed',
  'credits.released', 'billing.refund', 'keys.exported', 'keys.imported',
  'admin.backup_created', 'admin.backup_restored', 'stripe.checkout_created',
]);

const CONFIG_CHANGE_EVENTS = new Set([
  'config.reloaded', 'config.export', 'maintenance.enabled', 'maintenance.disabled',
  'key.quota_updated', 'key.tags_updated', 'key.limit_updated',
  'key.alias_set', 'key.note_added', 'key.note_deleted',
  'admin.alerts_configured', 'admin.cache_cleared', 'admin.circuit_reset',
  'template.created', 'template.updated', 'template.deleted',
  'team.created', 'team.updated', 'team.deleted',
  'group.created', 'group.updated', 'group.deleted',
  'webhook_filter.created', 'webhook_filter.updated', 'webhook_filter.deleted',
  'schedule.created', 'schedule.executed', 'schedule.cancelled',
]);

const SECURITY_EVENTS = new Set([
  'admin.auth_failed', 'key.revoked', 'key.suspended',
  'admin_key.revoked', 'admin_key.bootstrap_rotated',
  'oauth.token_revoked', 'token.revoked',
]);

// ─── Framework-specific descriptions ──────────────────────────────────────────

const FRAMEWORK_SECTIONS: Record<ComplianceFramework, {
  accessControl: { title: string; description: string };
  dataProcessing: { title: string; description: string };
  configChanges: { title: string; description: string };
  security: { title: string; description: string };
}> = {
  soc2: {
    accessControl: {
      title: 'CC6.1 – Logical Access Controls',
      description: 'Access provisioning, de-provisioning, key rotation, and authentication events.',
    },
    dataProcessing: {
      title: 'CC7.2 – System Operations Monitoring',
      description: 'Tool call processing, credit operations, billing, and data import/export events.',
    },
    configChanges: {
      title: 'CC8.1 – Change Management',
      description: 'Configuration changes, maintenance windows, template updates, and system modifications.',
    },
    security: {
      title: 'CC6.8 – Security Incident Detection',
      description: 'Authentication failures, key revocations, suspicious activity, and security events.',
    },
  },
  gdpr: {
    accessControl: {
      title: 'Article 25 – Data Protection by Design',
      description: 'Access control events demonstrating data protection measures and access management.',
    },
    dataProcessing: {
      title: 'Article 30 – Records of Processing Activities',
      description: 'Data processing events including tool calls, data transfers, and billing operations.',
    },
    configChanges: {
      title: 'Article 32 – Security of Processing',
      description: 'System configuration changes and security measure updates.',
    },
    security: {
      title: 'Article 33 – Notification of Data Breaches',
      description: 'Security events, authentication failures, and potential breach indicators.',
    },
  },
  hipaa: {
    accessControl: {
      title: '§164.312(a) – Access Control',
      description: 'Electronic access control events, user authentication, and authorization management.',
    },
    dataProcessing: {
      title: '§164.312(b) – Audit Controls',
      description: 'Information system activity records, data processing, and transaction logs.',
    },
    configChanges: {
      title: '§164.312(e) – Transmission Security',
      description: 'System configuration modifications and security parameter changes.',
    },
    security: {
      title: '§164.308(a)(6) – Security Incident Procedures',
      description: 'Security incidents, unauthorized access attempts, and incident response events.',
    },
  },
};

// ─── Severity Mapping ─────────────────────────────────────────────────────────

function getSeverity(eventType: string): 'info' | 'warning' | 'critical' {
  if (eventType === 'admin.auth_failed') return 'critical';
  if (eventType === 'key.revoked' || eventType === 'admin_key.revoked') return 'warning';
  if (eventType === 'key.suspended') return 'warning';
  if (eventType === 'gate.deny') return 'warning';
  if (eventType === 'maintenance.enabled') return 'warning';
  if (eventType === 'admin_key.bootstrap_rotated') return 'warning';
  return 'info';
}

// ─── Report Generator ─────────────────────────────────────────────────────────

function classifyEvent(event: AuditEvent): ComplianceEvent {
  const parts = event.type.split('.');
  return {
    timestamp: event.timestamp,
    category: parts[0] || 'unknown',
    action: parts.slice(1).join('.') || event.type,
    actor: event.actor,
    detail: event.message,
    severity: getSeverity(event.type),
    metadata: Object.keys(event.metadata).length > 0 ? event.metadata : undefined,
  };
}

/**
 * Generate a compliance report from audit log events.
 */
export function generateComplianceReport(
  auditLogger: AuditLogger,
  framework: ComplianceFramework,
  options: {
    since?: string;
    until?: string;
    serverVersion: string;
  },
): ComplianceReport {
  const periodEnd = options.until || new Date().toISOString();
  const periodStart = options.since || new Date(Date.now() - 30 * 86_400_000).toISOString(); // Default: last 30 days

  // Query all events in the period
  const query: AuditQuery = {
    since: periodStart,
    until: periodEnd,
    limit: 10_000, // Max export size
  };
  const result = auditLogger.query(query);
  const events = result.events;

  const frameworkConfig = FRAMEWORK_SECTIONS[framework];

  // Classify events into sections
  const accessControlEvents: ComplianceEvent[] = [];
  const dataProcessingEvents: ComplianceEvent[] = [];
  const configChangeEvents: ComplianceEvent[] = [];
  const securityEvents: ComplianceEvent[] = [];

  const actors = new Set<string>();
  let authFailures = 0;
  let keysCreated = 0;
  let keysRevoked = 0;
  let keysSuspended = 0;

  for (const event of events) {
    const classified = classifyEvent(event);
    actors.add(event.actor);

    if (ACCESS_CONTROL_EVENTS.has(event.type)) {
      accessControlEvents.push(classified);
    }
    if (DATA_PROCESSING_EVENTS.has(event.type)) {
      dataProcessingEvents.push(classified);
    }
    if (CONFIG_CHANGE_EVENTS.has(event.type)) {
      configChangeEvents.push(classified);
    }
    if (SECURITY_EVENTS.has(event.type)) {
      securityEvents.push(classified);
    }

    // Count specific events
    if (event.type === 'admin.auth_failed') authFailures++;
    if (event.type === 'key.created') keysCreated++;
    if (event.type === 'key.revoked') keysRevoked++;
    if (event.type === 'key.suspended') keysSuspended++;
  }

  return {
    meta: {
      framework,
      generatedAt: new Date().toISOString(),
      periodStart,
      periodEnd,
      serverVersion: options.serverVersion,
      totalEvents: events.length,
    },
    sections: [
      {
        ...frameworkConfig.accessControl,
        events: accessControlEvents,
        count: accessControlEvents.length,
      },
      {
        ...frameworkConfig.dataProcessing,
        events: dataProcessingEvents,
        count: dataProcessingEvents.length,
      },
      {
        ...frameworkConfig.configChanges,
        events: configChangeEvents,
        count: configChangeEvents.length,
      },
      {
        ...frameworkConfig.security,
        events: securityEvents,
        count: securityEvents.length,
      },
    ],
    summary: {
      totalAccessControlEvents: accessControlEvents.length,
      totalDataProcessingEvents: dataProcessingEvents.length,
      totalConfigChangeEvents: configChangeEvents.length,
      totalSecurityEvents: securityEvents.length,
      authFailures,
      keysCreated,
      keysRevoked,
      keysSuspended,
      uniqueActors: actors.size,
    },
  };
}

/**
 * Convert a compliance report to CSV format.
 */
export function complianceReportToCsv(report: ComplianceReport): string {
  const header = 'section,timestamp,category,action,actor,severity,detail';
  const rows: string[] = [];

  for (const section of report.sections) {
    for (const event of section.events) {
      rows.push(
        `"${section.title}",${event.timestamp},${event.category},${event.action},"${event.actor.replace(/"/g, '""')}",${event.severity},"${event.detail.replace(/"/g, '""')}"`
      );
    }
  }

  return [header, ...rows].join('\n');
}
