using System;
using System.Collections.Generic;
using System.Linq;
using Sayanho.Core.Models;

namespace Sayanho.Core.Logic
{
    /// <summary>
    /// Single-phase vs three-phase connection compatibility.
    /// Mirrors Sayanho.Frontend PhaseCompatibility.ts — keep both in sync.
    ///
    /// Rule: a single-phase outgoing point must not feed a three-phase incomer
    /// (e.g. HTPN FP incomer needs a 3-phase feed), and a three-phase outgoing
    /// point must not feed a single-phase incomer. Per-point configuration
    /// (Busbar Phase, LT Panel Pole) is honoured so the same physical point can
    /// be single- or three-phase depending on user configuration.
    /// Unknown (unconfigured) on either side is permissive.
    /// </summary>
    public static class PhaseCompatibility
    {
        public enum PhaseKind { Single, Three, Unknown }

        public sealed record PhaseInfo(PhaseKind Kind, string Label);

        public static bool IsSinglePhasePole(string? pole)
        {
            if (string.IsNullOrWhiteSpace(pole)) return false;
            var u = pole.Trim().ToUpperInvariant();
            return u.StartsWith("DP", StringComparison.Ordinal)
                || u.StartsWith("SP", StringComparison.Ordinal)
                || u.StartsWith("1P", StringComparison.Ordinal)
                || u.StartsWith("2P", StringComparison.Ordinal);
        }

        public static bool IsThreePhasePole(string? pole)
        {
            if (string.IsNullOrWhiteSpace(pole)) return false;
            var u = pole.Trim().ToUpperInvariant();
            return u.StartsWith("TP", StringComparison.Ordinal)
                || u.StartsWith("FP", StringComparison.Ordinal)
                || u.StartsWith("3P", StringComparison.Ordinal)
                || u.StartsWith("4P", StringComparison.Ordinal);
        }

        public static int GetOutgoingSlotIndex(string? pointKey)
        {
            if (string.IsNullOrWhiteSpace(pointKey)) return -1;
            var key = pointKey.Trim();
            if (!key.StartsWith("out", StringComparison.OrdinalIgnoreCase)) return -1;
            var rest = key.Substring(3);
            var digits = new string(rest.TakeWhile(char.IsDigit).ToArray());
            return int.TryParse(digits, out var n) ? n - 1 : -1;
        }

        private static int GetIncomerSection(string? pointKey)
        {
            if (string.IsNullOrWhiteSpace(pointKey)) return -1;
            var key = pointKey.Trim();
            if (!key.StartsWith("in", StringComparison.OrdinalIgnoreCase)) return -1;
            var rest = key.Substring(2);
            // "in" alone (HTPN/VTPN/SPN) has no section number.
            if (rest.Length == 0) return -1;
            return int.TryParse(new string(rest.TakeWhile(char.IsDigit).ToArray()), out var n) ? n : -1;
        }

        private static Dictionary<string, string> Props(CanvasItem? item) =>
            (item?.Properties != null && item.Properties.Count > 0)
                ? item.Properties[0] : new Dictionary<string, string>();

        private static bool IsSinglePhaseSwitchVoltage(string voltage, string itemName)
        {
            var v = (voltage ?? "").ToUpperInvariant();
            if (itemName == "Main Switch") return v.Contains("DP") || v.Contains("230V");
            if (itemName == "Change Over Switch") return v.Contains("DP") || v.Contains("230V");
            return false;
        }

        private static bool IsThreePhaseSwitchVoltage(string voltage)
        {
            var v = (voltage ?? "").ToUpperInvariant();
            return v.Contains("TPN") || v.Contains("FP") || v.Contains("415V") || v.Contains("440V");
        }

        public static PhaseInfo GetOutgoingPhaseType(CanvasItem item, string pointKey)
        {
            var name = item.Name ?? "";
            var props = Props(item);
            var outgoings = item.Outgoing ?? new List<Dictionary<string, string>>();

            if (name == "Source")
            {
                var t = props.GetValueOrDefault("Type", "") ?? "";
                if (System.Text.RegularExpressions.Regex.IsMatch(t, @"3\s*-\s*phase", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                    return new PhaseInfo(PhaseKind.Three, "Source (3-phase)");
                if (System.Text.RegularExpressions.Regex.IsMatch(t, @"1\s*-\s*phase", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                    || t.Contains("single", StringComparison.OrdinalIgnoreCase))
                    return new PhaseInfo(PhaseKind.Single, "Source (1-phase)");
                return new PhaseInfo(PhaseKind.Unknown, "Source (unconfigured type)");
            }

            if (name.Contains("HTPN"))
                return new PhaseInfo(PhaseKind.Single, $"HTPN way {pointKey} (single-phase)");

            if (name.Contains("VTPN"))
                return new PhaseInfo(PhaseKind.Three, $"VTPN outgoing {pointKey} (3-phase)");

            if (name == "SPN DB")
                return new PhaseInfo(PhaseKind.Single, $"SPN DB outgoing {pointKey} (single-phase)");

            if (name == "Busbar Chamber")
            {
                var bars = (props.GetValueOrDefault("Bars", "4") ?? "4").Trim();
                if (bars == "2")
                    return new PhaseInfo(PhaseKind.Single, $"Busbar tap {pointKey} (2-bar single-phase)");
                var idx = GetOutgoingSlotIndex(pointKey);
                var configured = (idx >= 0 && idx < outgoings.Count)
                    ? (outgoings[idx].GetValueOrDefault("Phase", "") ?? "") : "";
                var defaults = new[] { "R", "Y", "B" };
                var phase = (!string.IsNullOrWhiteSpace(configured) ? configured : defaults[Math.Max(idx, 0) % 3]).Trim().ToUpperInvariant();
                if (phase == "ALL")
                    return new PhaseInfo(PhaseKind.Three, $"Busbar tap {pointKey} (3-phase ALL)");
                return new PhaseInfo(PhaseKind.Single, $"Busbar tap {pointKey} (single-phase {phase})");
            }

            if (name.Contains("Cubical Panel") || name.Contains("Cubicle Panel"))
            {
                var idx = GetOutgoingSlotIndex(pointKey);
                Dictionary<string, string>? outProp = (idx >= 0 && idx < outgoings.Count) ? outgoings[idx] : null;
                if (outProp == null)
                    return new PhaseInfo(PhaseKind.Unknown, $"LT Panel outgoing {pointKey} (unconfigured)");
                var pole = (outProp.GetValueOrDefault("Pole", "") ?? "").Trim();
                var phase = (outProp.GetValueOrDefault("Phase", "") ?? "").Trim();
                if (IsSinglePhasePole(pole))
                    return new PhaseInfo(PhaseKind.Single, $"LT Panel outgoing {pointKey} (single-phase {pole}{(string.IsNullOrEmpty(phase) ? "" : $", {phase}")})");
                if (!string.IsNullOrEmpty(pole))
                    return new PhaseInfo(PhaseKind.Three, $"LT Panel outgoing {pointKey} (3-phase {pole})");
                return new PhaseInfo(PhaseKind.Unknown, $"LT Panel outgoing {pointKey} (unconfigured pole)");
            }

            if (name == "Main Switch" || name == "Change Over Switch")
            {
                var voltage = (props.GetValueOrDefault("Voltage", "") ?? "").Trim();
                if (string.IsNullOrEmpty(voltage))
                    return new PhaseInfo(PhaseKind.Unknown, $"{name} outgoing (unconfigured voltage)");
                if (IsSinglePhaseSwitchVoltage(voltage, name))
                    return new PhaseInfo(PhaseKind.Single, $"{name} outgoing (single-phase {voltage})");
                if (IsThreePhaseSwitchVoltage(voltage))
                    return new PhaseInfo(PhaseKind.Three, $"{name} outgoing (3-phase {voltage})");
                return new PhaseInfo(PhaseKind.Unknown, $"{name} outgoing (unconfigured voltage)");
            }

            if (name == "Point Switch Board" || name == "Avg. 5A Switch Board")
                return new PhaseInfo(PhaseKind.Single, $"{name} outgoing {pointKey} (single-phase)");

            if (name == "Portal")
                return new PhaseInfo(PhaseKind.Unknown, "Portal (phase follows linked net)");

            return new PhaseInfo(PhaseKind.Unknown, $"{name} outgoing {pointKey}");
        }

        public static PhaseInfo GetIncomingPhaseType(CanvasItem item, string pointKey)
        {
            var name = item.Name ?? "";
            var props = Props(item);

            if (name.Contains("HTPN"))
                return new PhaseInfo(PhaseKind.Three, "HTPN incomer (4-pole FP, 3-phase)");

            if (name.Contains("VTPN"))
                return new PhaseInfo(PhaseKind.Three, "VTPN incomer (3-phase)");

            if (name == "SPN DB")
                return new PhaseInfo(PhaseKind.Single, "SPN DB incomer (DP, single-phase)");

            if (name == "Busbar Chamber")
            {
                var bars = (props.GetValueOrDefault("Bars", "4") ?? "4").Trim();
                if (bars == "2")
                    return new PhaseInfo(PhaseKind.Single, "Busbar incomer (2-bar single-phase)");
                return new PhaseInfo(PhaseKind.Three, "Busbar incomer (4-bar 3-phase)");
            }

            if (name.Contains("Cubical Panel") || name.Contains("Cubicle Panel"))
            {
                var sec = GetIncomerSection(pointKey);
                if (sec < 1)
                    return new PhaseInfo(PhaseKind.Unknown, $"LT Panel incomer {pointKey} (unknown section)");
                var type = (props.GetValueOrDefault($"Incomer{sec}_Type", "") ?? "").Trim();
                var pole = (props.GetValueOrDefault($"Incomer{sec}_Pole", "") ?? "").Trim();
                if (string.IsNullOrEmpty(pole) && type == "Main Switch Open") pole = "TPN";
                if (IsSinglePhasePole(pole))
                    return new PhaseInfo(PhaseKind.Single, $"LT Panel incomer {sec} (single-phase {pole})");
                if (!string.IsNullOrEmpty(pole))
                    return new PhaseInfo(PhaseKind.Three, $"LT Panel incomer {sec} (3-phase {pole})");
                if (!string.IsNullOrEmpty(type))
                    return new PhaseInfo(PhaseKind.Three, $"LT Panel incomer {sec} (3-phase {type})");
                return new PhaseInfo(PhaseKind.Unknown, $"LT Panel incomer {sec} (unconfigured)");
            }

            if (name == "Main Switch" || name == "Change Over Switch")
            {
                var voltage = (props.GetValueOrDefault("Voltage", "") ?? "").Trim();
                if (string.IsNullOrEmpty(voltage))
                    return new PhaseInfo(PhaseKind.Unknown, $"{name} incomer (unconfigured voltage)");
                if (IsSinglePhaseSwitchVoltage(voltage, name))
                    return new PhaseInfo(PhaseKind.Single, $"{name} incomer (single-phase {voltage})");
                if (IsThreePhaseSwitchVoltage(voltage))
                    return new PhaseInfo(PhaseKind.Three, $"{name} incomer (3-phase {voltage})");
                return new PhaseInfo(PhaseKind.Unknown, $"{name} incomer (unconfigured voltage)");
            }

            if (name == "Source")
                return new PhaseInfo(PhaseKind.Unknown, "Source has no incomer");

            if (name == "Portal")
                return new PhaseInfo(PhaseKind.Unknown, "Portal (phase follows linked net)");

            return new PhaseInfo(PhaseKind.Single, $"{name} incomer (single-phase)");
        }

        /// <returns>(ok, error). Unknown on either side is permissive.</returns>
        public static (bool Ok, string? Error) ValidateConnectionPhase(
            CanvasItem sourceItem, string sourcePointKey,
            CanvasItem targetItem, string targetPointKey)
        {
            var src = GetOutgoingPhaseType(sourceItem, sourcePointKey);
            var dst = GetIncomingPhaseType(targetItem, targetPointKey);

            if (src.Kind == PhaseKind.Unknown || dst.Kind == PhaseKind.Unknown)
                return (true, null);
            if (src.Kind == dst.Kind)
                return (true, null);

            const string threeHint = "Feed it from a 3-phase outgoing: Source (3-phase), VTPN outgoing, Busbar ALL tap (4-bar), LT Panel 3-phase outgoing (TP/FP/TPN), or Main/Change-Over Switch at 415V.";
            const string singleHint = "Feed it from a single-phase outgoing: Source (1-phase), HTPN way, SPN DB outgoing, Busbar R/Y/B tap, LT Panel single-phase outgoing (SP/DP/1P with R/Y/B), or Main/Change-Over Switch at 230V DP.";

            if (src.Kind == PhaseKind.Single && dst.Kind == PhaseKind.Three)
                return (false,
                    $"Incompatible connection: single-phase outgoing ({src.Label}) cannot feed a 3-phase incomer ({dst.Label}). {threeHint}");

            return (false,
                $"Incompatible connection: 3-phase outgoing ({src.Label}) cannot feed a single-phase incomer ({dst.Label}). {singleHint}");
        }
    }
}
