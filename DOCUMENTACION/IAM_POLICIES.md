# IAM policies Delivrix

## DelivrixOpenClawRoute53Read

Fecha: 2026-06-01

Estado: manual operator step. Codex no aplico esta policy en AWS porque requiere acceso operativo IAM a la cuenta Infradelivrix `397450413307`.

Aplicar al IAM user `delivrix-openclaw-prod` como policy inline o policy administrada paralela a `DelivrixOpenClawBedrockInvoke`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["route53domains:GetDomainDetail"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["route53:ListResourceRecordSets"],
      "Resource": "arn:aws:route53:::hostedzone/*"
    }
  ]
}
```

Uso: habilita las tools read-only `read_route53_domain_detail` y `read_route53_zone_records` para que OpenClaw diagnostique registrar, nameservers y records Route53 sin pedir `dig`, `whois` ni AWS CLI al operador.
