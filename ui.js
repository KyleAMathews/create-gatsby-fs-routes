const React = require("react")
const { Box, Text, useInput } = require("ink")
const fetch = require("node-fetch")
const { Machine, assign } = require("xstate")
const { useMachine } = require("@xstate/react")
const slugify = require("@sindresorhus/slugify")
const TextInput = require("ink-text-input").default
const fs = require(`fs`)
const sysPath = require(`path`)

// If the node value is meant to be a slug, like `foo/bar`, the slugify
// function will remove the slashes. This is a hack to make sure the slashes
// stick around in the final url structuring
function safeSlugify(nodeValue) {
  // The incoming GraphQL data can also be a number
  const input = String(nodeValue)
  const tempArr = input.split(`/`)

  return tempArr.map(v => slugify(v)).join(`/`)
}

const fetchTypes = () =>
  fetch(`http://localhost:8000/__graphql`, {
    method: `post`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
  __schema {
    types {
      name
      description
      interfaces {
        name
      }
    }
  }
}`,
    }),
  })
    .then(result => result.json())
    .then(result =>
      result.data.__schema.types
        .filter(t => t.interfaces?.[0])
        .filter(
          t =>
            ![`Site`, `SitePage`, `SitePlugin`, `SiteBuildMetadata`].includes(
              t.name
            )
        )
    )
    .then(async types => {
      const result = await Promise.all(
        types.map(async (type, i) => {
          types[i].fields = await getFields(type.name)
        })
      )
      return types
    })

const getFields = async (type, depth = 0) => {
  if (depth > 1) {
    return []
  }

  const result = await fetch(`http://localhost:8000/__graphql`, {
    method: `post`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `
  {
  __type(name: "${type}") {
    name
    fields {
      name
      type {
        name
        kind
        ofType {
          name
          kind
        }
      }
    }
  }
}`,
    }),
  })
  const json = await result.json()
  let fields = json.data.__type.fields.filter(
    field => ![`internal`, `parent`, `children`].includes(field.name)
  )

  // Hard code adding slug field to MarkdownRemark
  if (type === `MarkdownRemark`) {
    fields = fields.map(f => {
      if (f.name === `fields`) {
        f.name = `fields__slug`
      }
      return f
    })
  }

  // let subFields = [];
  // await Promise.all(
  // fields.map(async (f, i) => {
  // if (f.type.kind === `OBJECT`) {
  // const result = await getFields(f.type.name);
  // // parent___child & then use that in constructing the queries.
  // // Maybe just hard-code slug though for the demo 🤷‍♂️
  // // const mappedResult = result.map(
  // console.log(result);
  // subFields = [...subFields, ...result];
  // }
  // })
  // );

  // console.log({ subFields });
  // return fields.concat(subFields);
  return fields
}

const getNodePaths = async (type, field) => {
  let query
  let isSlug = false
  if (field.name === `fields__slug`) {
    isSlug = true
    query = {
      query: `
  {
    allMarkdownRemark {
      nodes {
        fields { slug }
      }
    }
  }
`,
    }
  } else {
    query = {
      query: `
  {
    all${type.name} {
      nodes {
        ${field.name}
      }
    }
  }
`,
    }
  }
  const result = await fetch(`http://localhost:8000/__graphql`, {
    method: `post`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  })
  const json = await result.json()
  const hasNoErrors = !json.errors
  if (hasNoErrors) {
    const fields = json.data[`all${type.name}`].nodes.map(n => {
      // console.log(n);
      if (isSlug) {
        return n.fields.slug
      } else {
        return n[field.name]
      }
    })
    return fields.map(safeSlugify)
  } else {
    // console.log(json.errors);
    return []
  }
}

// Stateless machine definition
// machine.transition(...) is a pure function used by the interpreter.
const machine = Machine({
  id: "route-app",
  initial: "types",
  context: {
    typesIndex: 0,
    fieldsIndex: 0,
    types: [],
    focusedInput: ``,
    prefix: ``,
    postfix: ``,
  },
  on: {
    SAVE: `writingToDisk`,
  },
  states: {
    types: {
      invoke: {
        id: `fetchTypes`,
        src: (context, event) => fetchTypes(),
        onDone: {
          actions: assign((context, event) => {
            return {
              types: event.data,
            }
          }),
        },
      },
      on: {
        RIGHT_ARROW: "fields",
        DOWN_ARROW: {
          actions: assign((context, event) => {
            if (context.typesIndex + 1 < context.types.length) {
              const newIndex = context.typesIndex + 1
              return {
                typesIndex: newIndex,
                fieldsIndex: 0,
              }
            }
          }),
        },
        UP_ARROW: {
          actions: assign((context, event) => {
            if (context.typesIndex > 0) {
              return { typesIndex: context.typesIndex - 1, fieldsIndex: 0 }
            }
          }),
        },
      },
    },
    fields: {
      on: {
        RIGHT_ARROW: "input",
        LEFT_ARROW: "types",
        DOWN_ARROW: {
          actions: assign((context, event) => {
            if (
              context.fieldsIndex + 1 <
              context.types[context.typesIndex].fields.length
            ) {
              const newIndex = context.fieldsIndex + 1
              return {
                fieldsIndex: newIndex,
              }
            }
          }),
        },
        UP_ARROW: {
          actions: assign((context, event) => {
            if (context.fieldsIndex > 0) {
              return { fieldsIndex: context.fieldsIndex - 1 }
            }
          }),
        },
      },
    },
    input: {
      entry: assign(() => {
        return { focusedInput: `prefix` }
      }),
      on: {
        NEXT_INPUT: {
          actions: assign(() => {
            return {
              focusedInput: `postfix`,
            }
          }),
        },
        RETURN_FIELDS: {
          target: `fields`,
          actions: assign(() => {
            return {
              focusedInput: ``,
            }
          }),
        },
        SET_PREFIX: {
          actions: assign((ctx, event) => {
            return {
              prefix: event.val,
            }
          }),
        },
        SET_POSTFIX: {
          actions: assign((ctx, event) => {
            return {
              postfix: event.val,
            }
          }),
        },
      },
    },
    writingToDisk: {
      invoke: {
        id: `fetchTypes`,
        src: async (context, event) => {
          console.log(`saving...`)
          const activeType = context.types[context.typesIndex]
          const currentFields = context.types[context.typesIndex]?.fields || []
          const activeField = currentFields[context.fieldsIndex]
          const filepath = sysPath.join(
            process.cwd(),
            `src/pages/${context.prefix}{${activeType?.name}.${activeField?.name}${context.postfix}}.js`.replace(
              /([^:]\/)\/+/g,
              "$1"
            )
          )
          console.log({ filepath })
          // Ensure directory
          fs.mkdirSync(sysPath.dirname(filepath), { recursive: true })
          fs.writeFileSync(
            filepath,
            `import React from "react" \n\nexport default () => <div>created by {"${filepath}"}</div>`
          )
        },
        onDone: {
          target: `types`,
          actions: () => {
            console.log(`onDone`)
          },
        },
      },
    },
  },
})

const App = ({ port = 8000 }) => {
  const [types, setTypes] = React.useState([])
  const [paths, setPaths] = React.useState([])
  const [current, send] = useMachine(machine)
  useInput((input, key) => {
    if (key.downArrow) {
      send(`DOWN_ARROW`)
    } else if (key.upArrow) {
      send(`UP_ARROW`)
    } else if (key.rightArrow) {
      send(`RIGHT_ARROW`)
    } else if (key.leftArrow) {
      send(`LEFT_ARROW`)
    } else if (input == `s` && key.ctrl) {
      console.log(`input save`)
      send(`SAVE`)
    }
  })

  const currentFields =
    current.context.types[current.context.typesIndex]?.fields || []

  const activeType = current.context.types[current.context.typesIndex]
  const activeField = currentFields[current.context.fieldsIndex]

  // Query for nodes & generate paths.
  React.useEffect(() => {
    const fetchData = async () => {
      if (activeType && activeField) {
        const paths = await getNodePaths(activeType, activeField)
        // console.log({ paths });
        setPaths(paths)
      }
    }
    fetchData()
  }, [current.context.typesIndex, current.context.fieldsIndex])

  // console.log(current.value, current.event);

  return (
    <Box>
      <Box flexDirection="column" padding={1}>
        {current.context.types.map((t, i) => (
          <Text
            color={current.value === `types` ? `green` : `white`}
            key={`type-${t.name}`}
          >
            {i === current.context.typesIndex ? `>> ` : `   `}
            {t.name}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" padding={1}>
        {currentFields.map((f, i) => (
          <Text
            color={current.value === `fields` ? `green` : `white`}
            key={`field-${f.name}`}
          >
            {i === current.context.fieldsIndex ? `>> ` : `   `}
            {f.name}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" padding={1}>
        <Text>
          prefix:{" "}
          <TextInput
            focus={current.context.focusedInput === `prefix`}
            value={current.context.prefix}
            onChange={val => send(`SET_PREFIX`, { val })}
            onSubmit={val => {
              send(`NEXT_INPUT`)
            }}
          />
        </Text>
        <Text>
          filepath:{" "}
          {`src/pages/${current.context.prefix}{${activeType?.name}.${activeField?.name}${current.context.postfix}}.js`.replace(
            /([^:]\/)\/+/g,
            "$1"
          )}
        </Text>
        <Text>
          postfix:{" "}
          <TextInput
            focus={current.context.focusedInput === `postfix`}
            value={current.context.postfix}
            onChange={val => send(`SET_POSTFIX`, { val })}
            onSubmit={() => send(`RETURN_FIELDS`)}
          />
        </Text>
      </Box>
      <Box flexDirection="column" padding={1}>
        {paths.map((p, i) => (
          <Text key={`path-${i}`}>
            {`${current.context.prefix}${p}${current.context.postfix}`.replace(
              /([^:]\/)\/+/g,
              "$1"
            )}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

module.exports = App
