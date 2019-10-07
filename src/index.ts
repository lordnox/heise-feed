
import { InMemoryCache } from 'apollo-cache-inmemory'
import { ApolloClient } from 'apollo-client'
import { WebSocketLink } from 'apollo-link-ws'
import { isAfter } from 'date-fns'
import gql from 'graphql-tag'
import * as Parser from 'rss-parser'
import { SubscriptionClient } from 'subscriptions-transport-ws'
import * as ws from 'ws'
import { log } from './services/logger'

const GRAPHQL_SERVER_URI = 'ws://localhost:3421/graphql'

const subscriptionClient = new SubscriptionClient(GRAPHQL_SERVER_URI, { reconnect: true }, ws)

const client = new ApolloClient({
  cache: new InMemoryCache(),
  link: new WebSocketLink(subscriptionClient),
  defaultOptions: {
    watchQuery: {
      fetchPolicy: 'no-cache',
      errorPolicy: 'ignore',
    },
    query: {
      fetchPolicy: 'no-cache',
      errorPolicy: 'all',
    },
  },
})

let running = false

const parser = new Parser()

const getNewestFeedItems = log.on(async (old: Date | string) => {
  const feed = await parser.parseURL('https://www.heise.de/rss/heise.rdf')
  return feed.items //.filter(item => isAfter(item.isoDate, old))
}, 'getNewestFeedItems')

const checkForNewItems = async () => {
  if(running)
    return triggerError('Already running')
  running = true
  log('Checking for new items')
  const { data } = await client.query({
    query: gql`query {
      link: getLink(
        where: { tags_contains: "Heise"}
        order: datetime_DESC
      ) { datetime }
    }`,
  })
  const datetime: string = data.link ? data.link.datetime : '2000-01-01T00:00:00.000Z'
  log('timestamp: ' + datetime)
  return storeItems(datetime)
}

const triggerEvent = log.on((event: string, data: any, info: string = null) => client.mutate({
  mutation: gql`mutation CreateEvent($event: String!, $data: JSON, $info: String) {
    triggerEvent(name: $event, data: $data, info: $info)
  }`,
  variables: { event, data, info },
}).catch(log), 'trigger')

const triggerError = (error: string, data?: any) => triggerEvent(
  'heise-feed:error',
  { error, data },
  "Heise-Feed reports an error",
)

interface Link {
  url: string
  content?: string
  datetime: Date
  title: string
}

const createLink = async (item: Link) => {
  return client.mutate({
    mutation: gql`mutation createLink($title: String!, $url: String!, $date: DateTime!){
      createLink(data: {
        title: $title
        url: $url
        datetime: $date
        tags: ["Heise"]
      }) { id createdAt }
    }`,
    variables: { title: item.title, url: item.url, date: item.datetime },
  })
  .catch(error => {
    triggerError(error, { item })
    return null
  })
}

const storeItems = async (from: Date | string) => {
  const items = await getNewestFeedItems(from)
  await Promise.all(items.map(item => createLink({
    content: item.content,
    datetime: new Date(item.isoDate),
    title: item.title,
    url: item.link,
  })))
  if(items.length) {
    const info = items.length === 1 ? 'There is a new article' : `There are ${items.length} new articles`
    triggerEvent('heise-feed:result', { items: items.length, from }, info)
  }
  running = false
}

const observer = client.subscribe({
  query: gql`subscription { event: eventListener(name: "*") { name }}`,
})

log(`observer started at ${GRAPHQL_SERVER_URI}`)
observer
.filter(({ data: { event } }) => event.name.startsWith('heise-feed:'))
.map(({ data: { event, data } }) => ({ event: event.name.slice(11), data }))
.forEach(({ event, data }) => {
  log(event, data)
  if(event === 'start') return checkForNewItems().catch(err => console.error(err))
  // if(event.name === 'heise-feed')
  return true
})

client.subscribe({
  query: gql`subscription { event: eventListener(name: "ping") { name, data }}`,
})
.filter(({ data: { event }}) => event.data
  && typeof event.data.name === 'string'
  && typeof event.data.state === 'string'
  && event.data.name === 'heise-feed')
.forEach(({ data: { event } }) => {
  log('ping', event.data)
  client.mutate({
      mutation: gql`mutation($data: JSON) {
        triggerEvent(
          name: "pong"
          data: $data
        )
      }`,
      variables: { data: event.data },
    }).catch(log)
}).catch(log)
