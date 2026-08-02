{{/*
Helpers de nommage/labels partages par tous les templates du chart.
*/}}

{{/* Nom de base (tronque a 63 car. pour respecter les limites k8s). */}}
{{- define "accord-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Nom pleinement qualifie de la release. */}}
{{- define "accord-backend.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "accord-backend.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels standards recommandes par k8s. */}}
{{- define "accord-backend.labels" -}}
app.kubernetes.io/name: {{ include "accord-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Labels de selection (stables, ne changent pas entre versions). */}}
{{- define "accord-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "accord-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Tag d'image effectif (fallback sur AppVersion). */}}
{{- define "accord-backend.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}
