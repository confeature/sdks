// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import io.confeature.client.User;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * ConfigCat-parity flag evaluator. Pure function over a parsed {@code config_v6} map + {@link User}
 * → returns the resolved value (boolean / string / int / double) or the caller's typed fallback,
 * plus the matched-rule / matched-option / variation-id detail.
 *
 * <p>Ported from {@code packages/sdk-shared/src/{evaluator,comparators,hash,semver,segments,
 * prerequisites}.ts} (the spec-117 reference, proven byte-for-byte against ConfigCat). The
 * setting's {@code t} discriminator selects the value slot: {@code 0→v.b}, {@code 1→v.s}, {@code
 * 2→v.i}, {@code 3→v.d}.
 *
 * <p>Fail-closed semantics (FR-012/FR-013, SC-006): any reason a value can't be resolved cleanly
 * returns the caller's default plus a discrete {@link Error} code; <b>no exception ever escapes to
 * the caller</b>. A circular prerequisite chain throws {@link CircularDependencyException}
 * internally, caught by the outer fail-closed frame → bounded fallback + error (no {@code
 * StackOverflowError}).
 */
public final class Evaluator {

  /** Setting-type discriminator for boolean values. */
  public static final int SETTING_TYPE_BOOL = 0;

  /** Setting-type discriminator for string values. */
  public static final int SETTING_TYPE_STRING = 1;

  /** Setting-type discriminator for int values. */
  public static final int SETTING_TYPE_INT = 2;

  /** Setting-type discriminator for double values. */
  public static final int SETTING_TYPE_DOUBLE = 3;

  private static final String MISSING_USER_OBJECT_ERROR = "cannot evaluate, User Object is missing";

  // PrerequisiteFlagComparator codes.
  private static final int PREREQ_EQUALS = 0;
  static final int PREREQ_NOT_EQUALS = 1;

  // SegmentComparator codes.
  private static final int SEGMENT_IS_IN = 0;
  static final int SEGMENT_IS_NOT_IN = 1;

  private Evaluator() {
    // Utility class.
  }

  /** Discrete error classes — never surfaced to customers; used for logging. */
  public enum Error {
    NONE,
    NO_CONFIG,
    KEY_NOT_FOUND,
    UNSUPPORTED_TYPE,
    TYPE_MISMATCH,
    MALFORMED_VALUE,
    MALFORMED_CONFIG
  }

  /** Internal three-valued condition outcome kind (MATCH / NO_MATCH / VALIDATION_ERROR). */
  enum MatchOutcome {
    MATCH,
    NO_MATCH,
    VALIDATION_ERROR
  }

  /**
   * Three-valued condition outcome carrying the error text (data-model §3). Mirrors the TS {@code
   * ConditionOutcome} ({@code true | false | {error}}): an error short-circuits the AND group like
   * {@code false} but its message is surfaced for the trace's THEN consequence. {@code
   * comparisonValueError} flags the #509 malformed-operand path (a distinct WARN 3004 with no
   * "please check…" suffix).
   */
  static final class Outcome {
    final MatchOutcome kind;
    final String error;
    final boolean comparisonValueError;

    /**
     * The offending attribute name + parenthesised reason, when this is a typed-attribute
     * conversion failure (drives the WARN 3004 {@code userObjectAttributeIsInvalid} line). {@code
     * null} for the missing-user / missing-attribute / comparison-value outcomes.
     */
    final String attribute;

    final String reason;

    private Outcome(
        MatchOutcome kind,
        String error,
        boolean comparisonValueError,
        String attribute,
        String reason) {
      this.kind = kind;
      this.error = error;
      this.comparisonValueError = comparisonValueError;
      this.attribute = attribute;
      this.reason = reason;
    }

    static final Outcome MATCH = new Outcome(MatchOutcome.MATCH, null, false, null, null);
    static final Outcome NO_MATCH = new Outcome(MatchOutcome.NO_MATCH, null, false, null, null);

    static Outcome match(boolean b) {
      return b ? MATCH : NO_MATCH;
    }

    /** Generic validation error (missing user / missing attribute): no WARN 3004 from here. */
    static Outcome attributeError(String error) {
      return new Outcome(MatchOutcome.VALIDATION_ERROR, error, false, null, null);
    }

    /** Typed-attribute conversion failure: emits WARN 3004 {@code userObjectAttributeIsInvalid}. */
    static Outcome invalidAttribute(String error, String attribute, String reason) {
      return new Outcome(MatchOutcome.VALIDATION_ERROR, error, false, attribute, reason);
    }

    /**
     * Malformed CONFIG comparison value (#509): emits WARN 3004 {@code comparisonValueIsInvalid}.
     */
    static Outcome comparisonValueError(String error) {
      return new Outcome(MatchOutcome.VALIDATION_ERROR, error, true, null, null);
    }

    boolean isMatch() {
      return kind == MatchOutcome.MATCH;
    }

    boolean isError() {
      return kind == MatchOutcome.VALIDATION_ERROR;
    }
  }

  /** Thrown on a detected prerequisite cycle; caught by the evaluator's fail-closed frame. */
  static final class CircularDependencyException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    /** The cycle path (e.g. {@code key1 -> key1}) for the ERROR 1002 trace. */
    final String cycle;

    CircularDependencyException(String message, String cycle) {
      super(message);
      this.cycle = cycle;
    }
  }

  /** Thrown on a malformed config the engine cannot evaluate; caught by the fail-closed frame. */
  static final class MalformedConfigException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    MalformedConfigException(String message) {
      super(message);
    }
  }

  /** Evaluation outcome envelope (additive: variationId + matched rule/option). */
  public static final class Result {
    private final Object value;
    private final Error error;
    private final String variationId;
    private final boolean matchedTargetingRule;
    private final boolean matchedPercentageOption;
    private final String evalError;

    Result(
        Object value,
        Error error,
        String variationId,
        boolean matchedTargetingRule,
        boolean matchedPercentageOption,
        String evalError) {
      this.value = value;
      this.error = error;
      this.variationId = variationId;
      this.matchedTargetingRule = matchedTargetingRule;
      this.matchedPercentageOption = matchedPercentageOption;
      this.evalError = evalError;
    }

    public Result(Object value, Error error) {
      this(value, error, null, false, false, null);
    }

    public Object getValue() {
      return value;
    }

    public Error getError() {
      return error;
    }

    /** Variation id of the resolved value (matched rule / option / setting {@code i}). */
    public String getVariationId() {
      return variationId;
    }

    /** {@code true} when a targeting rule decided the value. */
    public boolean hasMatchedTargetingRule() {
      return matchedTargetingRule;
    }

    /** {@code true} when a percentage option decided the value. */
    public boolean hasMatchedPercentageOption() {
      return matchedPercentageOption;
    }

    /**
     * Informational evaluation error surfaced when a condition errored (missing user / attribute /
     * validation) but a value still resolved cleanly. {@code null} on the clean path.
     */
    public String getEvalError() {
      return evalError;
    }
  }

  /** The resolved {@code v} envelope + matched-rule/option identity (internal). */
  private static final class SettingResult {
    final Map<String, Object> value;
    String variationId;
    boolean matchedRule;
    boolean matchedOption;

    SettingResult(Map<String, Object> value, String variationId) {
      this.value = value;
      this.variationId = variationId;
    }
  }

  /** Per-evaluation context threaded through rule / condition / prerequisite resolution. */
  private static final class EvalContext {
    final String key;
    final Map<String, Object> setting;
    final Map<String, Object> settings;
    final List<Object> segments;
    final String configSalt;
    final UserView user;
    final List<String> visitedFlags;
    final EvalTraceLog log;
    final EvalLog.EvaluateLogBuilder logBuilder;
    String evalError;
    boolean missingUserLogged;

    EvalContext(
        String key,
        Map<String, Object> setting,
        Map<String, Object> settings,
        List<Object> segments,
        String configSalt,
        UserView user,
        List<String> visitedFlags,
        EvalTraceLog log,
        EvalLog.EvaluateLogBuilder logBuilder) {
      this.key = key;
      this.setting = setting;
      this.settings = settings;
      this.segments = segments;
      this.configSalt = configSalt;
      this.user = user;
      this.visitedFlags = visitedFlags;
      this.log = log;
      this.logBuilder = logBuilder;
    }

    /**
     * Derive a child context for a prerequisite flag: same config / user / visited-flags stack /
     * trace, but a fresh {@code missingUserLogged} so a prereq referenced by N rules logs WARN 3001
     * N times (common-js parity). The child seeds the parent's first surfaced error.
     */
    EvalContext withChild(String childKey, Map<String, Object> childSetting) {
      final EvalContext child =
          new EvalContext(
              childKey,
              childSetting,
              settings,
              segments,
              configSalt,
              user,
              visitedFlags,
              log,
              logBuilder);
      child.evalError = this.evalError;
      return child;
    }
  }

  /**
   * Public {@link User} adapter to the typed-attribute view the engine reads. The public {@code
   * User.custom} is {@code Map<String,Object>}, mirroring ConfigCat: custom values arrive TYPED
   * (number / boolean / Date / array / String) and flow un-stringified into the comparator-layer
   * conversion, so a non-string attribute converts per ConfigCat (number → invariant decimal,
   * Date/Instant → epoch seconds, array → JSON) exactly as the upstream SDK.
   */
  static UserView fromPublicUser(User user) {
    return user == null ? null : new PublicUserView(user);
  }

  /**
   * Resolve {@code key} against the full parsed {@code config_v6} map + {@link User}. NEVER throws.
   *
   * @param config parsed {@code config_v6.json} root ({@code {p,f,s}}), or {@code null}.
   * @param key flag key to resolve.
   * @param defaultValue caller's fallback (also the TYPE_MISMATCH discriminator).
   * @param user targeting context, or {@code null}.
   */
  public static Result evaluate(
      Map<String, Object> config, String key, Object defaultValue, User user) {
    return evaluateWith(config, key, defaultValue, fromPublicUser(user));
  }

  /**
   * Internal entrypoint taking the typed {@link UserView} (the conformance harness feeds native
   * number / array / epoch attributes through {@code CorpusUserView}; the public path adapts {@link
   * User} via {@link #fromPublicUser}).
   */
  static Result evaluateWith(
      Map<String, Object> config, String key, Object defaultValue, UserView user) {
    return evaluateTraced(config, key, defaultValue, user, null);
  }

  /**
   * {@link #evaluateWith} with an optional eval-log trace sink (ADR 0003 / epic #494, #501). When
   * the sink is INFO-enabled it drives the ConfigCat byte-identical evaluation-log trace: the WARN
   * 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and the final INFO 5000 multi-line
   * indented trace. A {@code null} sink (the hot path) is zero-cost — identical behaviour to {@link
   * #evaluateWith}.
   */
  static Result evaluateTraced(
      Map<String, Object> config,
      String key,
      Object defaultValue,
      UserView user,
      EvalTraceLog.Sink sink) {
    final EvalTraceLog log = new EvalTraceLog(sink);
    if (config == null) {
      return new Result(defaultValue, Error.NO_CONFIG);
    }

    final Map<String, Object> settings = asMap(config.get("f"));
    if (settings == null) {
      return new Result(defaultValue, Error.NO_CONFIG);
    }
    final Object settingAny = settings.get(key);
    if (settingAny == null) {
      return new Result(defaultValue, Error.KEY_NOT_FOUND);
    }
    final Map<String, Object> setting = asMap(settingAny);
    if (setting == null) {
      return new Result(defaultValue, Error.MALFORMED_CONFIG);
    }
    final Integer settingType = readInt(setting.get("t"));
    if (settingType == null) {
      return new Result(defaultValue, Error.MALFORMED_CONFIG);
    }
    if (settingType != SETTING_TYPE_BOOL
        && settingType != SETTING_TYPE_STRING
        && settingType != SETTING_TYPE_INT
        && settingType != SETTING_TYPE_DOUBLE) {
      return new Result(defaultValue, Error.UNSUPPORTED_TYPE);
    }

    // Default-value type guard (preserves the existing tier-0 TYPE_MISMATCH contract). A null
    // default bypasses the check.
    if (defaultValue != null && !defaultMatchesType(defaultValue, settingType)) {
      return new Result(defaultValue, Error.TYPE_MISMATCH);
    }

    final Map<String, Object> preferences = asMap(config.get("p"));
    final String configSalt =
        preferences != null && preferences.get("s") instanceof String
            ? (String) preferences.get("s")
            : "";
    final List<Object> segments = asList(config.get("s"));

    // Evaluation-log trace (ADR 0003). Built lazily — only when the sink would emit at INFO. The
    // header is appended here; the `Returning '<value>'.` footer below; the whole multi-line trace
    // is surfaced under event id 5000.
    EvalLog.EvaluateLogBuilder logBuilder = null;
    if (log.enabled(EvalTraceLog.Level.INFO)) {
      logBuilder = new EvalLog.EvaluateLogBuilder();
      logBuilder.append("Evaluating '" + key + "'");
      if (user != null) {
        logBuilder.append(" for User '" + userAttributesForLogJson(user) + "'");
      }
    }

    final EvalContext ctx =
        new EvalContext(
            key,
            setting,
            settings,
            segments == null ? Collections.emptyList() : segments,
            configSalt,
            user,
            new ArrayList<>(),
            log,
            logBuilder);

    final SettingResult sr;
    try {
      sr = evaluateSetting(ctx);
    } catch (CircularDependencyException e) {
      // A prerequisite cycle fail-closes with ConfigCat's distinct ERROR 1002 (naming the setting +
      // the chain), not the generic evaluation path.
      log.circularDependency(key, e.cycle);
      return new Result(defaultValue, Error.MALFORMED_CONFIG);
    } catch (RuntimeException e) {
      return new Result(defaultValue, Error.MALFORMED_CONFIG);
    }

    final Object raw = selectSettingValue(sr.value, settingType);
    final Object typed = coerceTyped(raw, settingType);
    if (typed == null) {
      return new Result(defaultValue, Error.MALFORMED_VALUE);
    }

    // Footer + emit. The INFO 5000 trace is emitted only when the resolved value is clean.
    if (logBuilder != null) {
      logBuilder.newLine("Returning '" + EvalLog.settingValueToLogString(typed) + "'.");
      log.info(EvalLog.EVENT_ID, logBuilder.toString());
    }

    final String variationId =
        sr.variationId != null ? sr.variationId : readString(setting.get("i"));
    return new Result(
        typed, Error.NONE, variationId, sr.matchedRule, sr.matchedOption, ctx.evalError);
  }

  /**
   * Render the user's attributes as the eval-log header shows them — a Confeature-canonical object
   * {@code {Identifier, Email?, Country?, …custom}} JSON-serialized to the {@code for User '…'}
   * token (ADR 0003 addendum). This is the configcat-js form; insertion order is fixed (Identifier,
   * Email, Country, then custom in encounter order), and the serialization is compact with JS-JSON
   * string escaping ({@code JSON.stringify}).
   */
  private static String userAttributesForLogJson(UserView user) {
    final StringBuilder sb = new StringBuilder();
    sb.append('{');
    sb.append("\"Identifier\":")
        .append(jsJsonString(user.identifier() == null ? "" : user.identifier()));

    final Object email = user.attribute("Email");
    if (email instanceof String && !((String) email).isEmpty()) {
      sb.append(",\"Email\":").append(jsJsonString((String) email));
    }
    final Object country = user.attribute("Country");
    if (country instanceof String && !((String) country).isEmpty()) {
      sb.append(",\"Country\":").append(jsJsonString((String) country));
    }
    for (final String name : user.customKeys()) {
      sb.append(',')
          .append(jsJsonString(name))
          .append(':')
          .append(jsJsonString(Comparators.userAttributeValueToString(user.attribute(name))));
    }
    sb.append('}');
    return sb.toString();
  }

  /**
   * Serialize a string exactly as ECMAScript {@code JSON.stringify} renders a string value:
   * double-quoted, with {@code "}, {@code \}, and the C0 control characters escaped, all other code
   * points emitted verbatim.
   */
  private static String jsJsonString(String s) {
    final StringBuilder sb = new StringBuilder();
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      final char ch = s.charAt(i);
      switch (ch) {
        case '"':
          sb.append("\\\"");
          break;
        case '\\':
          sb.append("\\\\");
          break;
        case '\b':
          sb.append("\\b");
          break;
        case '\t':
          sb.append("\\t");
          break;
        case '\n':
          sb.append("\\n");
          break;
        case '\f':
          sb.append("\\f");
          break;
        case '\r':
          sb.append("\\r");
          break;
        default:
          if (ch < 0x20) {
            sb.append(String.format("\\u%04x", (int) ch));
          } else {
            sb.append(ch);
          }
          break;
      }
    }
    sb.append('"');
    return sb.toString();
  }

  /**
   * Resolve a setting to its {@code v} envelope + matched-rule/option identity: targeting-rule walk
   * (first-match-wins), then setting-level percentage options, then the served fallback.
   */
  private static SettingResult evaluateSetting(EvalContext ctx) {
    final List<Object> rules = asList(ctx.setting.get("r"));
    if (rules != null && !rules.isEmpty()) {
      final SettingResult ruleResult = evaluateTargetingRules(rules, ctx);
      if (ruleResult != null) {
        return ruleResult;
      }
    }

    final List<Object> options = asList(ctx.setting.get("p"));
    if (options != null && !options.isEmpty()) {
      final SettingResult optionResult = evaluatePercentageOptions(options, false, ctx);
      if (optionResult != null) {
        return optionResult;
      }
    }

    return new SettingResult(asMap(ctx.setting.get("v")), readString(ctx.setting.get("i")));
  }

  /** Walk {@code setting.r[]} in document order; first rule whose AND-conditions all match wins. */
  private static SettingResult evaluateTargetingRules(List<Object> rules, EvalContext ctx) {
    final EvalLog.EvaluateLogBuilder lb = ctx.logBuilder;
    if (lb != null) {
      lb.newLine("Evaluating targeting rules and applying the first match if any:");
    }
    for (final Object ruleAny : rules) {
      final Map<String, Object> rule = asMap(ruleAny);
      if (rule == null) {
        continue;
      }
      final List<Object> conditions = asList(rule.get("c"));
      final Outcome outcome =
          evaluateConditions(
              conditions == null ? Collections.emptyList() : conditions, ctx.key, ctx, rule);
      if (!outcome.isMatch()) {
        // A rule whose conditions ERRORED (missing user/attr/validation) is ignored and evaluation
        // continues — ConfigCat emits this trace line. A rule that merely did NOT match (false)
        // just continues, with no such line.
        if (outcome.isError() && lb != null) {
          lb.increaseIndent()
              .newLine(
                  "The current targeting rule is ignored and the evaluation continues with the"
                      + " next rule.")
              .decreaseIndent();
        }
        continue;
      }

      final Map<String, Object> served = asMap(rule.get("s"));
      if (served != null) {
        final SettingResult r =
            new SettingResult(asMap(served.get("v")), readString(served.get("i")));
        r.matchedRule = true;
        return r;
      }
      // A rule serving % options: the block is traced one level deeper (under the rule). If the
      // options can't resolve (no user / missing keying attr) the rule is ignored and evaluation
      // continues.
      final List<Object> options = asList(rule.get("p"));
      if (lb != null) {
        lb.increaseIndent();
      }
      final SettingResult optionResult =
          evaluatePercentageOptions(options == null ? Collections.emptyList() : options, true, ctx);
      if (optionResult != null) {
        if (lb != null) {
          lb.decreaseIndent();
        }
        return optionResult;
      }
      if (lb != null) {
        lb.newLine(
                "The current targeting rule is ignored and the evaluation continues with the next"
                    + " rule.")
            .decreaseIndent();
      }
    }
    return null;
  }

  /**
   * Resolve a percentage-option list to its bucket: {@code sha1(key + attrValue)[0,7] % 100}, keyed
   * by the setting's {@code a} attribute (default Identifier). Returns {@code null} (skip) when
   * there is no user or the keying attribute is missing.
   */
  private static SettingResult evaluatePercentageOptions(
      List<Object> options, boolean fromRule, EvalContext ctx) {
    final EvalLog.EvaluateLogBuilder lb = ctx.logBuilder;
    if (ctx.user == null) {
      surfaceMissingUser(ctx);
      if (lb != null) {
        lb.newLine("Skipping % options because the User Object is missing.");
      }
      return null;
    }

    String attrName = ctx.setting.get("a") instanceof String ? (String) ctx.setting.get("a") : null;
    Object attrValue;
    if (attrName == null) {
      attrName = "Identifier";
      attrValue = ctx.user.identifier();
      if (attrValue == null) {
        attrValue = "";
      }
    } else {
      attrValue = ctx.user.attribute(attrName);
    }
    if (attrValue == null) {
      if (ctx.evalError == null) {
        ctx.evalError = missingUserAttributeError(attrName);
      }
      ctx.log.userObjectAttributeIsMissingForPercentage(ctx.key, attrName);
      if (lb != null) {
        lb.newLine("Skipping % options because the User." + attrName + " attribute is missing.");
      }
      return null;
    }

    final int hashValue =
        Hashing.percentageBucket(ctx.key, Comparators.userAttributeValueToString(attrValue));

    if (lb != null) {
      lb.newLine("Evaluating % options based on the User." + attrName + " attribute:");
      lb.newLine(
          "- Computing hash in the [0..99] range from User."
              + attrName
              + " => "
              + hashValue
              + " (this value is sticky and consistent across all SDKs)");
    }

    int bucket = 0;
    for (int i = 0; i < options.size(); i++) {
      final Map<String, Object> option = asMap(options.get(i));
      if (option == null) {
        continue;
      }
      final Integer width = readInt(option.get("p"));
      if (width == null) {
        continue;
      }
      bucket += width;
      if (hashValue >= bucket) {
        continue;
      }
      final Map<String, Object> optionValue = asMap(option.get("v"));
      if (lb != null) {
        lb.newLine(
            "- Hash value "
                + hashValue
                + " selects % option "
                + (i + 1)
                + " ("
                + width
                + "%), '"
                + EvalLog.settingValueToLogString(
                    selectSettingValue(optionValue, settingTypeOf(ctx)))
                + "'.");
      }
      final SettingResult r = new SettingResult(optionValue, readString(option.get("i")));
      r.matchedRule = fromRule;
      r.matchedOption = true;
      return r;
    }
    // Sum of widths < 100 — a malformed config. Throw to the fail-closed frame.
    throw new MalformedConfigException("Sum of percentage option percentages is less than 100.");
  }

  /**
   * AND-grouped condition list, short-circuiting on the first non-match / error. When {@code rule}
   * is non-null its THEN consequence is traced (a bare segment passes {@code null}). Mirrors
   * evaluator.ts {@code evaluateConditions}.
   */
  private static Outcome evaluateConditions(
      List<Object> conditions, String contextSalt, EvalContext ctx, Map<String, Object> rule) {
    final EvalLog.EvaluateLogBuilder lb = ctx.logBuilder;
    Outcome result = Outcome.MATCH;
    if (lb != null) {
      lb.newLine("- ");
    }
    for (int i = 0; i < conditions.size(); i++) {
      final Map<String, Object> condition = asMap(conditions.get(i));
      if (lb != null) {
        if (i == 0) {
          lb.append("IF ").increaseIndent();
        } else {
          lb.increaseIndent().newLine("AND ");
        }
      }

      if (condition == null) {
        result = Outcome.attributeError("");
      } else if (condition.get("u") != null) {
        result = evaluateUserCondition(asMap(condition.get("u")), contextSalt, ctx);
      } else if (condition.get("p") != null) {
        result = Outcome.match(evaluatePrerequisiteCondition(asMap(condition.get("p")), ctx));
      } else if (condition.get("s") != null) {
        result = evaluateSegmentCondition(asMap(condition.get("s")), ctx);
      } else {
        result = Outcome.attributeError("");
      }

      if (lb != null) {
        // The go-sdk oracle always shows the per-condition consequence (even for a
        // single-condition rule, where configcat-js omits it) — match go.
        lb.appendConditionConsequence(result.isMatch());
        lb.decreaseIndent();
      }

      if (!result.isMatch()) {
        break;
      }
    }

    // When evaluating a targeting rule (not a bare segment), append its THEN consequence. The go
    // oracle always newlines THEN when the rule has conditions.
    if (rule != null && lb != null) {
      final Map<String, Object> served = asMap(rule.get("s"));
      final String thenValue =
          served != null
              ? EvalLog.settingValueToLogString(
                  selectSettingValue(asMap(served.get("v")), settingTypeOf(ctx)))
              : null;
      final EvalLog.MatchOrError matchKind;
      if (result.isMatch()) {
        matchKind = EvalLog.MatchOrError.match();
      } else if (result.isError()) {
        matchKind = EvalLog.MatchOrError.err(result.error == null ? "" : result.error);
      } else {
        matchKind = EvalLog.MatchOrError.noMatch();
      }
      lb.appendTargetingRuleConsequence(thenValue, matchKind, !conditions.isEmpty());
    }

    return result;
  }

  /** Dispatch one user condition to its comparator. */
  private static Outcome evaluateUserCondition(
      Map<String, Object> condition, String contextSalt, EvalContext ctx) {
    final EvalLog.EvaluateLogBuilder lb = ctx.logBuilder;
    final Integer cmpForLog = condition == null ? null : readInt(condition.get("c"));
    if (lb != null) {
      lb.appendUserCondition(
          condition == null ? null : readString(condition.get("a")),
          cmpForLog == null ? -1 : cmpForLog,
          condition == null ? null : readString(condition.get("s")),
          condition == null ? null : readDouble(condition.get("d")),
          condition == null ? null : readStringList(condition.get("l")));
    }

    if (condition == null) {
      return Outcome.attributeError("");
    }
    if (ctx.user == null) {
      surfaceMissingUser(ctx);
      return Outcome.attributeError(MISSING_USER_OBJECT_ERROR);
    }

    final String attrName = readString(condition.get("a"));
    final Object attrValue = attrName == null ? null : ctx.user.attribute(attrName);
    if (attrName == null || attrValue == null || "".equals(attrValue)) {
      final String msg = missingUserAttributeError(attrName == null ? "" : attrName);
      if (ctx.evalError == null) {
        ctx.evalError = msg;
      }
      // ConfigCat logs a WARN (event 3003) per targeting rule whose attribute is missing — not
      // deduped per evaluation.
      ctx.log.userObjectAttributeIsMissing(ctx.key, attrName == null ? "" : attrName);
      return Outcome.attributeError(msg);
    }

    final Integer cmpAny = readInt(condition.get("c"));
    if (cmpAny == null) {
      return Outcome.attributeError("");
    }
    final int cmp = cmpAny;
    final String configSalt = ctx.configSalt;
    final List<String> list = readStringList(condition.get("l"));
    final String sv = readString(condition.get("s"));
    final String svOrEmpty = sv != null ? sv : "";
    final Double dvBoxed = readDouble(condition.get("d"));
    final double dv = dvBoxed != null ? dvBoxed : 0;

    final Outcome outcome =
        dispatchComparator(
            cmp, attrName, attrValue, list, svOrEmpty, dvBoxed, dv, configSalt, contextSalt);

    // Surface the WARN 3004 lines for typed-attribute / comparison-value failures.
    if (outcome.isError()) {
      if (outcome.comparisonValueError) {
        if (ctx.evalError == null) {
          ctx.evalError = outcome.error;
        }
        ctx.log.comparisonValueIsInvalid(ctx.key, outcome.error);
      } else if (outcome.attribute != null && outcome.reason != null) {
        if (ctx.evalError == null) {
          ctx.evalError = outcome.error;
        }
        ctx.log.userObjectAttributeIsInvalid(ctx.key, outcome.attribute, outcome.reason);
      }
    }
    return outcome;
  }

  /** Dispatch the comparator slot to its evaluator, validating the config operand first (#509). */
  private static Outcome dispatchComparator(
      int cmp,
      String attrName,
      Object attrValue,
      List<String> list,
      String svOrEmpty,
      Double dvBoxed,
      double dv,
      String configSalt,
      String contextSalt) {
    switch (cmp) {
      case Comparators.TEXT_EQUALS:
      case Comparators.TEXT_NOT_EQUALS:
        return outcomeOf(
            Comparators.evaluateTextEquals(
                Comparators.attributeAsText(attrValue),
                svOrEmpty,
                cmp == Comparators.TEXT_NOT_EQUALS));
      case Comparators.SENSITIVE_TEXT_EQUALS:
      case Comparators.SENSITIVE_TEXT_NOT_EQUALS:
        return outcomeOf(
            Comparators.evaluateSensitiveTextEquals(
                Comparators.attributeAsText(attrValue),
                svOrEmpty,
                configSalt,
                contextSalt,
                cmp == Comparators.SENSITIVE_TEXT_NOT_EQUALS));
      case Comparators.TEXT_IS_ONE_OF:
      case Comparators.TEXT_IS_NOT_ONE_OF:
        return outcomeOf(
            Comparators.evaluateTextIsOneOf(
                Comparators.attributeAsText(attrValue),
                list,
                cmp == Comparators.TEXT_IS_NOT_ONE_OF));
      case Comparators.SENSITIVE_TEXT_IS_ONE_OF:
      case Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF:
        return outcomeOf(
            Comparators.evaluateSensitiveTextIsOneOf(
                Comparators.attributeAsText(attrValue),
                list,
                configSalt,
                contextSalt,
                cmp == Comparators.SENSITIVE_TEXT_IS_NOT_ONE_OF));
      case Comparators.TEXT_STARTS_WITH_ANY_OF:
      case Comparators.TEXT_NOT_STARTS_WITH_ANY_OF:
        return outcomeOf(
            Comparators.evaluateTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue),
                list,
                true,
                cmp == Comparators.TEXT_NOT_STARTS_WITH_ANY_OF));
      case Comparators.SENSITIVE_TEXT_STARTS_WITH_ANY_OF:
      case Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF:
        return outcomeOf(
            Comparators.evaluateSensitiveTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue),
                list,
                configSalt,
                contextSalt,
                true,
                cmp == Comparators.SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF));
      case Comparators.TEXT_ENDS_WITH_ANY_OF:
      case Comparators.TEXT_NOT_ENDS_WITH_ANY_OF:
        return outcomeOf(
            Comparators.evaluateTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue),
                list,
                false,
                cmp == Comparators.TEXT_NOT_ENDS_WITH_ANY_OF));
      case Comparators.SENSITIVE_TEXT_ENDS_WITH_ANY_OF:
      case Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF:
        return outcomeOf(
            Comparators.evaluateSensitiveTextSliceEqualsAnyOf(
                Comparators.attributeAsText(attrValue),
                list,
                configSalt,
                contextSalt,
                false,
                cmp == Comparators.SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF));
      case Comparators.TEXT_CONTAINS_ANY_OF:
      case Comparators.TEXT_NOT_CONTAINS_ANY_OF:
        return outcomeOf(
            Comparators.evaluateTextContainsAnyOf(
                Comparators.attributeAsText(attrValue),
                list,
                cmp == Comparators.TEXT_NOT_CONTAINS_ANY_OF));
      case Comparators.SEMVER_IS_ONE_OF:
      case Comparators.SEMVER_IS_NOT_ONE_OF:
        {
          final Comparators.Convert<Semver> r = Comparators.attributeAsSemVer(attrName, attrValue);
          if (!r.ok) {
            return invalidAttributeOutcome(r);
          }
          return outcomeOf(
              Comparators.evaluateSemVerIsOneOf(
                  r.value, list, cmp == Comparators.SEMVER_IS_NOT_ONE_OF));
        }
      case Comparators.SEMVER_LESS:
      case Comparators.SEMVER_LESS_OR_EQUALS:
      case Comparators.SEMVER_GREATER:
      case Comparators.SEMVER_GREATER_OR_EQUALS:
        {
          // configcat-common validates the CONFIG comparison value BEFORE the user attribute
          // (#509): a malformed operand wins even when the attribute is also malformed.
          final Comparators.Convert<Semver> cv = Comparators.comparisonValueAsSemVer(svOrEmpty);
          if (!cv.ok) {
            return Outcome.comparisonValueError(cv.error);
          }
          final Comparators.Convert<Semver> r = Comparators.attributeAsSemVer(attrName, attrValue);
          if (!r.ok) {
            return invalidAttributeOutcome(r);
          }
          return outcomeOf(Comparators.evaluateSemVerRelation(r.value, cmp, svOrEmpty));
        }
      case Comparators.NUMBER_EQUALS:
      case Comparators.NUMBER_NOT_EQUALS:
      case Comparators.NUMBER_LESS:
      case Comparators.NUMBER_LESS_OR_EQUALS:
      case Comparators.NUMBER_GREATER:
      case Comparators.NUMBER_GREATER_OR_EQUALS:
        {
          final Comparators.Convert<Double> cv = Comparators.comparisonValueAsNumber(dvBoxed);
          if (!cv.ok) {
            return Outcome.comparisonValueError(cv.error);
          }
          final Comparators.Convert<Double> r = Comparators.attributeAsNumber(attrName, attrValue);
          if (!r.ok) {
            return invalidAttributeOutcome(r);
          }
          return outcomeOf(Comparators.evaluateNumberRelation(r.value, cmp, dv));
        }
      case Comparators.DATETIME_BEFORE:
      case Comparators.DATETIME_AFTER:
        {
          final Comparators.Convert<Double> cv =
              Comparators.comparisonValueAsUnixTimeSeconds(dvBoxed);
          if (!cv.ok) {
            return Outcome.comparisonValueError(cv.error);
          }
          final Comparators.Convert<Double> r =
              Comparators.attributeAsUnixTimeSeconds(attrName, attrValue);
          if (!r.ok) {
            return invalidAttributeOutcome(r);
          }
          return outcomeOf(
              Comparators.evaluateDateTimeRelation(
                  r.value, dv, cmp == Comparators.DATETIME_BEFORE));
        }
      case Comparators.ARRAY_CONTAINS_ANY_OF:
      case Comparators.ARRAY_NOT_CONTAINS_ANY_OF:
        {
          final Comparators.Convert<List<String>> r =
              Comparators.attributeAsStringArray(attrName, attrValue);
          if (!r.ok) {
            return invalidAttributeOutcome(r);
          }
          return outcomeOf(
              Comparators.evaluateArrayContainsAnyOf(
                  r.value, list, cmp == Comparators.ARRAY_NOT_CONTAINS_ANY_OF));
        }
      case Comparators.SENSITIVE_ARRAY_CONTAINS_ANY_OF:
      case Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF:
        {
          final Comparators.Convert<List<String>> r =
              Comparators.attributeAsStringArray(attrName, attrValue);
          if (!r.ok) {
            return invalidAttributeOutcome(r);
          }
          return outcomeOf(
              Comparators.evaluateSensitiveArrayContainsAnyOf(
                  r.value,
                  list,
                  configSalt,
                  contextSalt,
                  cmp == Comparators.SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF));
        }
      default:
        return Outcome.attributeError("");
    }
  }

  /** Map a failed typed-attribute conversion to its WARN-3004-bearing {@link Outcome}. */
  private static Outcome invalidAttributeOutcome(Comparators.Convert<?> r) {
    return Outcome.invalidAttribute(r.error, r.attribute, r.reason);
  }

  /**
   * Resolve a prerequisite-flag condition (child context, fresh missing-user state). Returns a
   * plain boolean ({@code true}/{@code false}); a cycle / malformed reference throws to the
   * fail-closed frame.
   */
  private static boolean evaluatePrerequisiteCondition(
      Map<String, Object> condition, EvalContext ctx) {
    if (condition == null) {
      throw new MalformedConfigException("Prerequisite condition is missing or invalid.");
    }
    final String prereqKey = readString(condition.get("f"));
    if (prereqKey == null) {
      throw new MalformedConfigException("Prerequisite flag key is missing or invalid.");
    }
    final Map<String, Object> prereqSetting = asMap(ctx.settings.get(prereqKey));
    if (prereqSetting == null) {
      throw new MalformedConfigException("Prerequisite flag is missing or invalid.");
    }
    final Integer declaredType = readInt(prereqSetting.get("t"));
    if (declaredType == null) {
      throw new MalformedConfigException("Prerequisite flag is missing or invalid.");
    }

    final Object comparisonValue = selectSettingValue(asMap(condition.get("v")), declaredType);

    final EvalLog.EvaluateLogBuilder lb = ctx.logBuilder;
    final Integer cmp = readInt(condition.get("c"));
    if (cmp == null) {
      throw new MalformedConfigException("Comparison operator is missing or invalid.");
    }
    if (lb != null) {
      lb.appendPrerequisiteFlagCondition(
          prereqKey,
          cmp,
          comparisonValue != null ? EvalLog.settingValueToLogString(comparisonValue) : "");
    }

    // Cycle detection: push current key, detect a revisit before recursing.
    ctx.visitedFlags.add(ctx.key);
    if (ctx.visitedFlags.contains(prereqKey)) {
      ctx.visitedFlags.add(prereqKey);
      final String cycle = String.join(" -> ", ctx.visitedFlags);
      throw new CircularDependencyException(
          "Circular dependency detected between the following depending flags: " + cycle + ".",
          cycle);
    }

    // The prerequisite evaluates in its OWN context (fresh missingUserLogged) so a prereq
    // referenced by N rules logs WARN 3001 N times, not once (common-js parity).
    final EvalContext childCtx = ctx.withChild(prereqKey, prereqSetting);

    // The trace re-enters the full evaluation nested in `( … )` (go-sdk oracle structure): the
    // child appends its own "Evaluating '<key>' …" header + "Returning …".
    if (lb != null) {
      lb.newLine("(").increaseIndent().newLine("Evaluating '" + prereqKey + "'");
      if (ctx.user != null) {
        lb.append(" for User '" + userAttributesForLogJson(ctx.user) + "'");
      }
    }

    final SettingResult resolvedEnvelope = evaluateSetting(childCtx);

    if (lb != null) {
      final Object childValue = selectSettingValue(resolvedEnvelope.value, declaredType);
      lb.newLine("Returning '" + EvalLog.settingValueToLogString(childValue) + "'.")
          .decreaseIndent()
          .newLine(")");
    }

    if (childCtx.evalError != null && ctx.evalError == null) {
      ctx.evalError = childCtx.evalError;
    }
    // Restore the stack for sibling prerequisites.
    ctx.visitedFlags.remove(ctx.visitedFlags.size() - 1);

    final Object resolvedValue = selectSettingValue(resolvedEnvelope.value, declaredType);
    final boolean equal = nullSafeEquals(resolvedValue, comparisonValue);
    switch (cmp) {
      case PREREQ_EQUALS:
        return equal;
      case PREREQ_NOT_EQUALS:
        return !equal;
      default:
        throw new MalformedConfigException("Comparison operator is missing or invalid.");
    }
  }

  /** Resolve a segment condition (sensitive context salt = segment NAME). */
  private static Outcome evaluateSegmentCondition(Map<String, Object> condition, EvalContext ctx) {
    if (condition == null) {
      throw new MalformedConfigException("Segment reference is invalid.");
    }
    final EvalLog.EvaluateLogBuilder lb = ctx.logBuilder;
    final Integer index = readInt(condition.get("s"));
    final Map<String, Object> segment =
        (index != null && index >= 0 && index < ctx.segments.size())
            ? asMap(ctx.segments.get(index))
            : null;
    final String segmentName = segment == null ? null : readString(segment.get("n"));
    final Integer segCmp = readInt(condition.get("c"));
    if (lb != null) {
      lb.appendSegmentCondition(
          segmentName == null ? "" : segmentName, segCmp == null ? SEGMENT_IS_IN : segCmp);
    }

    if (ctx.user == null) {
      surfaceMissingUser(ctx);
      return Outcome.attributeError(MISSING_USER_OBJECT_ERROR);
    }
    if (segment == null) {
      throw new MalformedConfigException("Segment reference is invalid.");
    }
    if (segmentName == null || segmentName.isEmpty()) {
      throw new MalformedConfigException("Segment name is missing.");
    }

    if (lb != null) {
      lb.newLine("(").increaseIndent().newLine("Evaluating segment '" + segmentName + "':");
    }

    // The segment's AND-grouped bare user conditions, traced via the shared evaluateConditions
    // path (segment name = the sensitive-comparator salt).
    final List<Object> segConditions = asList(segment.get("r"));
    final List<Object> wrapped = new ArrayList<>();
    if (segConditions != null) {
      for (final Object ucAny : segConditions) {
        final Map<String, Object> cond = new java.util.LinkedHashMap<>();
        cond.put("u", ucAny);
        wrapped.add(cond);
      }
    }

    final Outcome inSegment = evaluateConditions(wrapped, segmentName, ctx, null);

    // IsNotIn negates a boolean outcome; an error is surfaced un-negated.
    Outcome result = inSegment;
    if (!inSegment.isError() && segCmp != null && segCmp == SEGMENT_IS_NOT_IN) {
      result = Outcome.match(!inSegment.isMatch());
    }

    if (lb != null) {
      lb.newLine("Segment evaluation result: ");
      if (!inSegment.isError()) {
        lb.append(inSegment.isMatch() ? "User IS IN SEGMENT" : "User IS NOT IN SEGMENT");
      } else {
        lb.append(inSegment.error == null ? "" : inSegment.error);
      }
      lb.append(".");
      lb.newLine("Condition (")
          .appendSegmentCondition(segmentName, segCmp == null ? SEGMENT_IS_IN : segCmp)
          .append(")");
      if (!result.isError()) {
        lb.append(" evaluates to ").appendConditionResult(result.isMatch());
      } else {
        lb.append(" failed to evaluate");
      }
      lb.append(".").decreaseIndent().newLine(")");
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private static void surfaceMissingUser(EvalContext ctx) {
    if (ctx.evalError == null) {
      ctx.evalError = MISSING_USER_OBJECT_ERROR;
    }
    // ConfigCat logs the no-user WARN (event 3001) once per context. A prerequisite flag evaluates
    // in its OWN context (fresh state), so a prereq referenced by N rules logs it N times
    // (common-js parity).
    if (!ctx.missingUserLogged) {
      ctx.log.userObjectIsMissing(ctx.key);
      ctx.missingUserLogged = true;
    }
  }

  private static String missingUserAttributeError(String attr) {
    return "cannot evaluate, the User." + attr + " attribute is missing";
  }

  private static Outcome outcomeOf(boolean b) {
    return Outcome.match(b);
  }

  /**
   * The setting type of the current eval context (drives the value-slot selection for the trace).
   */
  private static int settingTypeOf(EvalContext ctx) {
    final Integer t = readInt(ctx.setting.get("t"));
    return t == null ? SETTING_TYPE_BOOL : t;
  }

  /**
   * Select the typed value out of a {@code v} envelope by the setting's {@code t} discriminator.
   */
  private static Object selectSettingValue(Map<String, Object> value, int type) {
    if (value == null) {
      return null;
    }
    switch (type) {
      case SETTING_TYPE_BOOL:
        return value.get("b");
      case SETTING_TYPE_STRING:
        return value.get("s");
      case SETTING_TYPE_INT:
        return value.get("i");
      case SETTING_TYPE_DOUBLE:
        return value.get("d");
      default:
        return null;
    }
  }

  /** Coerce a selected raw value to the JVM type the setting type implies (or {@code null}). */
  private static Object coerceTyped(Object raw, int type) {
    switch (type) {
      case SETTING_TYPE_BOOL:
        return raw instanceof Boolean ? raw : null;
      case SETTING_TYPE_STRING:
        return raw instanceof String ? raw : null;
      case SETTING_TYPE_INT:
        return raw instanceof Number && !(raw instanceof Boolean)
            ? Integer.valueOf(((Number) raw).intValue())
            : null;
      case SETTING_TYPE_DOUBLE:
        return raw instanceof Number && !(raw instanceof Boolean)
            ? Double.valueOf(((Number) raw).doubleValue())
            : null;
      default:
        return null;
    }
  }

  private static boolean defaultMatchesType(Object defaultValue, int type) {
    switch (type) {
      case SETTING_TYPE_BOOL:
        return defaultValue instanceof Boolean;
      case SETTING_TYPE_STRING:
        return defaultValue instanceof String;
      case SETTING_TYPE_INT:
        return defaultValue instanceof Integer || defaultValue instanceof Long;
      case SETTING_TYPE_DOUBLE:
        return defaultValue instanceof Double || defaultValue instanceof Float;
      default:
        return false;
    }
  }

  private static boolean nullSafeEquals(Object a, Object b) {
    if (a == null) {
      return b == null;
    }
    if (a instanceof Number && b instanceof Number) {
      return ((Number) a).doubleValue() == ((Number) b).doubleValue();
    }
    return a.equals(b);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> asMap(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : null;
  }

  @SuppressWarnings("unchecked")
  private static List<Object> asList(Object o) {
    return o instanceof List ? (List<Object>) o : null;
  }

  private static String readString(Object o) {
    return o instanceof String ? (String) o : null;
  }

  private static List<String> readStringList(Object o) {
    final List<Object> list = asList(o);
    if (list == null) {
      return Collections.emptyList();
    }
    final List<String> out = new ArrayList<>(list.size());
    for (final Object e : list) {
      if (e instanceof String) {
        out.add((String) e);
      }
    }
    return out;
  }

  /** Reads a JSON-decoded number as an int (Integer/Long/Double/Number). */
  private static Integer readInt(Object raw) {
    if (raw instanceof Boolean) {
      return null;
    }
    if (raw instanceof Integer) {
      return (Integer) raw;
    }
    if (raw instanceof Long) {
      return ((Long) raw).intValue();
    }
    if (raw instanceof Number) {
      return ((Number) raw).intValue();
    }
    return null;
  }

  /** Reads a JSON-decoded number as a double (any Number variant). */
  private static Double readDouble(Object raw) {
    if (raw instanceof Boolean) {
      return null;
    }
    if (raw instanceof Number) {
      return ((Number) raw).doubleValue();
    }
    return null;
  }

  /** A typed user view the engine reads (identifier + typed attributes). */
  interface UserView {
    String identifier();

    /** The attribute value (well-known or custom), or {@code null} when absent. */
    Object attribute(String name);

    /**
     * Custom attribute keys in encounter order (excludes Identifier / Email / Country) — drives the
     * eval-log header's {@code for User '…'} JSON. Empty by default.
     */
    default Iterable<String> customKeys() {
      return Collections.emptyList();
    }
  }

  /** Adapter from the public {@link User} (custom values are typed {@code Object}s). */
  private static final class PublicUserView implements UserView {
    private final User user;

    PublicUserView(User user) {
      this.user = user;
    }

    @Override
    public String identifier() {
      return user.getIdentifier();
    }

    @Override
    public Object attribute(String name) {
      // Well-known attributes resolve to their String slots; custom values stay TYPED so the
      // comparator conversion layer applies ConfigCat's number/Date/array stringification.
      return user.getAttribute(name);
    }

    @Override
    public Iterable<String> customKeys() {
      final Map<String, Object> custom = user.getCustom();
      return custom == null ? Collections.emptyList() : custom.keySet();
    }
  }
}
