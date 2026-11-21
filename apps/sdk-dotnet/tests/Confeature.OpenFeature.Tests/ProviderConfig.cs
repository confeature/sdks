// SPDX-License-Identifier: MIT

namespace Confeature.OpenFeature.Tests;

internal static class ProviderConfig
{
    internal const string Json = """
        {"f":{
          "enabled":{"t":0,"v":{"b":true},"i":"on"},
          "text":{"t":1,"v":{"s":"{\"show\":true}"},"i":"text"},
          "integer":{"t":2,"v":{"i":7},"i":"integer"},
          "double":{"t":3,"v":{"d":1.5},"i":"double"},
          "targeted":{"t":0,"v":{"b":false},"i":"default","r":[
            {"c":[{"u":{"a":"plan","c":28,"s":"beta"}}],"s":{"v":{"b":true},"i":"beta"}}
          ]},
          "rollout":{"t":0,"v":{"b":false},"i":"default","r":[
            {"c":[{"u":{"a":"plan","c":28,"s":"beta"}}],"p":[{"p":100,"v":{"b":true},"i":"split"}]}
          ]},
          "rollout-all":{"t":0,"v":{"b":false},"i":"default",
            "p":[{"p":100,"v":{"b":true},"i":"split-all"}]},
          "rollout-custom":{"t":0,"v":{"b":false},"i":"default","a":"plan",
            "p":[{"p":100,"v":{"b":true},"i":"split-custom"}]},
          "typed":{"t":0,"v":{"b":false},"i":"default","r":[
            {"c":[{"u":{"a":"score","c":14,"d":10}},{"u":{"a":"member","c":28,"s":"true"}},
                  {"u":{"a":"teams","c":34,"l":["blue"]}},{"u":{"a":"joined","c":19,"d":1700000000}}],
             "s":{"v":{"b":true},"i":"typed"}}
          ]},
          "malformed":{"t":0,"v":{"s":"invalid"},"i":"unused"}
        }}
        """;

    internal const string RefreshedJson = """
        {"f":{"enabled":{"t":0,"v":{"b":false},"i":"refreshed"}}}
        """;
}
